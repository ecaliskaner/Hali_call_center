import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { config, loadBusiness } from "./config.js";
import { createHaliflex, normalizePhone } from "./haliflex/index.js";
import { CallSession } from "./agent/session.js";
import type { CallState } from "./agent/tools.js";

/**
 * Telefon sunucusu.
 *
 *  Müşteri arar → Twilio numarası → POST /voice  (TwiML: ConversationRelay başlat)
 *  Twilio sesi yazıya çevirir → WebSocket /relay → CallSession (Claude + Halıflex)
 *  Cevap metni → WebSocket → Twilio ElevenLabs ile seslendirir
 *  Görüşme bitince → POST /call-ended  (gerekirse çalışana aktar: <Dial>)
 */

const business = loadBusiness();
const crm = createHaliflex();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", config.publicUrl);
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, "ok", "text/plain");

    if (req.method === "POST" && (url.pathname === "/voice" || url.pathname === "/call-ended")) {
      const body = await readBody(req);
      const params = Object.fromEntries(new URLSearchParams(body));
      if (!verifyTwilio(req, url, params)) return send(res, 403, "invalid signature", "text/plain");
      if (url.pathname === "/voice") return send(res, 200, voiceTwiml(), "text/xml");
      return send(res, 200, callEndedTwiml(params), "text/xml");
    }
    send(res, 404, "not found", "text/plain");
  } catch (err) {
    console.error(err);
    send(res, 500, "error", "text/plain");
  }
});

function voiceTwiml(): string {
  const wsUrl = config.publicUrl.replace(/^http/, "ws") + `/relay?k=${encodeURIComponent(config.relaySecret)}`;
  const attrs: Record<string, string> = {
    url: wsUrl,
    language: config.tts.language,
    ttsProvider: config.tts.provider,
    transcriptionProvider: config.stt.provider,
    speechModel: config.stt.speechModel,
    interruptible: "any",
    dtmfDetection: "true",
  };
  if (config.tts.voice) attrs.voice = config.tts.voice;
  const a = Object.entries(attrs)
    .map(([k, v]) => `${k}="${xml(v)}"`)
    .join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="${xml(config.publicUrl + "/call-ended")}">
    <ConversationRelay ${a} />
  </Connect>
</Response>`;
}

function callEndedTwiml(params: Record<string, string>): string {
  let handoff: { transfer?: boolean } = {};
  try {
    handoff = JSON.parse(params.HandoffData ?? "{}");
  } catch {
    /* boş */
  }
  if (handoff.transfer && config.transferNumber) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${xml(config.transferNumber)}</Dial></Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
}

// ---- ConversationRelay WebSocket ----

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", config.publicUrl);
  const key = url.searchParams.get("k") ?? "";
  if (url.pathname !== "/relay" || !safeEqual(key, config.relaySecret)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => handleRelay(ws));
});

function handleRelay(ws: WebSocket) {
  let session: CallSession | null = null;
  let callSid = "";

  const sendJson = (o: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o));
  };

  ws.on("message", async (raw) => {
    let m: any;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (m.type) {
      case "setup": {
        callSid = m.callSid ?? "";
        const caller = typeof m.from === "string" && /\d{7,}/.test(m.from) ? normalizePhone(m.from) : "";
        const state: CallState = {
          callerPhone: caller,
          customer: null,
          business,
          crm,
          timezone: config.timezone,
          now: () => new Date(),
          endRequested: false,
          transfer: null,
        };
        session = new CallSession(state, {
          text: (token, last) => sendJson({ type: "text", token, last }),
          end: ({ transfer }) => {
            // Son cümlenin okunmasına zaman tanı, sonra oturumu kapat
            setTimeout(
              () => sendJson({ type: "end", handoffData: JSON.stringify({ transfer: !!transfer, ...transfer }) }),
              2500,
            );
          },
        });
        const greeting = await session.start();
        sendJson({ type: "text", token: greeting, last: true });
        console.log(`Arama başladı ${callSid} ${caller || "gizli"} müşteri=${state.customer?.id ?? "yeni"}`);
        break;
      }
      case "prompt":
        if (m.last !== false) session?.onUserSpeech(String(m.voicePrompt ?? ""));
        break;
      case "interrupt":
        session?.interrupt(m.utteranceUntilInterrupt);
        break;
      case "dtmf":
        // Tuşlama: 0'a basan müşteriyi çalışana aktar
        if (m.digit === "0") session?.onUserSpeech("(Müşteri telefonda 0 tuşuna bastı, bir çalışanla görüşmek istiyor.)");
        break;
      case "error":
        console.error("ConversationRelay hatası:", m.description);
        break;
    }
  });

  ws.on("close", () => {
    if (!session) return;
    session.close();
    saveTranscript(callSid, session);
    console.log(`Arama bitti ${callSid}`);
  });
}

function saveTranscript(callSid: string, s: CallSession) {
  try {
    fs.mkdirSync(config.callLogDir, { recursive: true });
    const file = path.join(config.callLogDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${callSid || "local"}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          callSid,
          arayan: s.state.callerPhone,
          musteri_id: s.state.customer?.id,
          aktarim: s.state.transfer,
          mesajlar: s.messages,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error("Görüşme kaydı yazılamadı:", err);
  }
}

// ---- yardımcılar ----

/** Twilio istek imzası doğrulaması (X-Twilio-Signature). TWILIO_AUTH_TOKEN yoksa atlanır. */
function verifyTwilio(req: http.IncomingMessage, url: URL, params: Record<string, string>): boolean {
  if (!config.twilioAuthToken) return true;
  const sig = req.headers["x-twilio-signature"];
  if (typeof sig !== "string") return false;
  const fullUrl = config.publicUrl + url.pathname + url.search;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], fullUrl);
  const expected = crypto.createHmac("sha1", config.twilioAuthToken).update(Buffer.from(data, "utf8")).digest("base64");
  return safeEqual(sig, expected);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: string, type: string) {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8` });
  res.end(body);
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

if (config.relaySecret === "degistir-beni") console.warn("UYARI: RELAY_SECRET varsayılan değerde, değiştirin.");
server.listen(config.port, () => {
  console.log(`Halı asistanı ${config.port} portunda. Twilio Voice webhook: ${config.publicUrl}/voice`);
  console.log(`Halıflex modu: ${config.haliflex.mode}, model: ${config.claudeModel}`);
});
