import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import { config } from "../config.js";
import { buildCallContext, buildGreeting, buildSystemPrompt } from "./prompt.js";
import { runTool, toolDefinitions, type CallState } from "./tools.js";

type Msg = Anthropic.Beta.BetaMessageParam;

export interface SessionOutput {
  /** Sese çevrilecek metin parçası. last=true cevabın bittiğini bildirir. */
  text(token: string, last: boolean): void;
  /** Görüşmeyi bitir; transfer varsa çalışana aktar. */
  end(result: { transfer: CallState["transfer"] }): void;
}

const MAX_TOOL_ROUNDS = 6;
const client = new Anthropic();

interface Turn {
  stream?: BetaMessageStream;
  aborted: boolean;
  /** Bu cevapta şimdiye kadar sese gönderilen metin */
  spoken: string;
  /** Henüz geçmişe (messages) yazılmamış kısmı */
  pending: string;
  spokenUntilInterrupt?: string;
}

/**
 * Tek bir telefon görüşmesinin konuşma döngüsü.
 * Müşteri konuşmasını alır, Claude'a gönderir, cevabı parça parça sese aktarır,
 * araç çağrılarını (Halıpratik, fiyat) çalıştırır. Müşteri sözünü keserse üretimi durdurur.
 */
export class CallSession {
  readonly messages: Msg[] = [];
  private readonly system: Anthropic.Beta.BetaTextBlockParam[];
  private current: Turn | null = null;
  private queue: Promise<void> = Promise.resolve();
  private ended = false;

  constructor(
    readonly state: CallState,
    private readonly out: SessionOutput,
  ) {
    this.system = [{ type: "text", text: buildSystemPrompt(state.business), cache_control: { type: "ephemeral" } }];
  }

  /** Arama başında: arayanı Halıpratik'te bulur, karşılama metnini döndürür (hemen okunması için). */
  async start(): Promise<string> {
    if (this.state.callerPhone) {
      try {
        this.state.customer = await this.state.crm.findCustomerByPhone(this.state.callerPhone);
      } catch (err) {
        console.error("Müşteri sorgusu başarısız:", (err as Error).message);
      }
    }
    const greeting = buildGreeting(this.state.business);
    this.messages.push(
      {
        role: "user",
        content: buildCallContext({
          now: this.state.now(),
          timezone: this.state.timezone,
          callerPhone: this.state.callerPhone,
          customer: this.state.customer,
          greeting,
        }),
      },
      { role: "assistant", content: greeting },
    );
    return greeting;
  }

  /** Müşterinin bir cümlesi (konuşmadan yazıya çevrilmiş) geldi. */
  onUserSpeech(text: string): Promise<void> {
    if (this.ended || !text.trim()) return this.queue;
    this.interrupt();
    this.queue = this.queue.then(() => this.respond(text)).catch((err) => console.error("Cevap hatası:", err));
    return this.queue;
  }

  /** Müşteri asistanın sözünü kesti. */
  interrupt(spokenUntilInterrupt?: string) {
    const t = this.current;
    if (!t || t.aborted) return;
    t.aborted = true;
    t.spokenUntilInterrupt = spokenUntilInterrupt;
    t.stream?.abort();
  }

  /** Bağlantı koptu / arama kapandı. */
  close() {
    this.ended = true;
    this.interrupt();
  }

  private async respond(userText: string): Promise<void> {
    if (this.ended) return;
    this.messages.push({ role: "user", content: userText });
    const turn: Turn = { aborted: false, spoken: "", pending: "" };
    this.current = turn;

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (turn.aborted || this.ended) return this.recordInterrupted(turn);

        // Araç turları arasında kelimeler birbirine yapışmasın
        if (turn.spoken && !/\s$/.test(turn.spoken)) this.emit(turn, " ");

        const stream = client.beta.messages.stream({
          model: config.claudeModel,
          max_tokens: 4096,
          system: this.system,
          tools: toolDefinitions,
          messages: this.messages,
          thinking: { type: "adaptive" },
          output_config: { effort: config.claudeEffort },
          cache_control: { type: "ephemeral" },
          // Güvenlik sınıflandırıcısı bir isteği reddederse sunucu tarafında otomatik yedek modele geçer
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          ...(process.env.CLAUDE_FAST === "1" ? { speed: "fast" as const } : {}),
        });
        turn.stream = stream;
        stream.on("text", (delta) => this.emit(turn, delta));

        let msg: Anthropic.Beta.BetaMessage;
        try {
          msg = await stream.finalMessage();
        } catch (err) {
          if (turn.aborted) return this.recordInterrupted(turn);
          throw err;
        }

        if (msg.stop_reason === "refusal") {
          const sorry = "Kusura bakmayın, bu konuda size yardımcı olamıyorum. Başka bir konuda yardımcı olabilir miyim?";
          this.emit(turn, sorry);
          this.messages.push({ role: "assistant", content: turn.spoken.trim() || sorry });
          this.out.text("", true);
          return;
        }

        this.messages.push({ role: "assistant", content: msg.content });
        turn.pending = "";

        const toolUses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (toolUses.length === 0 || msg.stop_reason !== "tool_use") {
          this.out.text("", true);
          return;
        }

        const results = await Promise.all(
          toolUses.map(async (tu) => {
            const r = await runTool(tu.name, tu.input, this.state);
            log(this.state, `araç ${tu.name}`, { girdi: tu.input, sonuc: r.content.slice(0, 500) });
            return {
              type: "tool_result" as const,
              tool_use_id: tu.id,
              content: r.content,
              ...(r.isError ? { is_error: true } : {}),
            };
          }),
        );
        this.messages.push({ role: "user", content: results });

        if (this.state.endRequested || this.state.transfer) {
          this.out.text("", true);
          this.finish();
          return;
        }
      }
      // Çok fazla araç turu: güvenli çıkış
      this.emit(turn, "Sizi bir arkadaşıma aktarıyorum, hemen yardımcı olacak.");
      this.out.text("", true);
      this.state.transfer = { reason: "araç turu sınırı aşıldı", summary: "Asistan isteği tamamlayamadı." };
      this.finish();
    } catch (err) {
      console.error("Claude/araç hatası:", err);
      const msg =
        err instanceof Anthropic.RateLimitError || err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.InternalServerError
          ? "Kusura bakmayın, sistemimizde kısa bir yoğunluk var. Sizi hemen bir arkadaşıma aktarıyorum."
          : "Kusura bakmayın, kısa bir sorun oldu. Sizi hemen bir arkadaşıma aktarıyorum.";
      this.emit(turn, msg);
      this.out.text("", true);
      this.state.transfer = { reason: "sistem hatası", summary: String((err as Error).message ?? err) };
      this.finish();
    } finally {
      if (this.current === turn) this.current = null;
    }
  }

  private emit(turn: Turn, token: string) {
    if (turn.aborted || this.ended) return;
    turn.spoken += token;
    turn.pending += token;
    this.out.text(token, false);
  }

  /** Söz kesildiğinde: müşterinin gerçekten duyduğu kısmı geçmişe yaz. */
  private recordInterrupted(turn: Turn) {
    // Twilio, sözün kesildiği ana kadar okunan metni bildirir; o yoksa gönderdiğimizi kullan
    const heard = (turn.spokenUntilInterrupt && turn.pending.includes(turn.spokenUntilInterrupt.trim())
      ? turn.spokenUntilInterrupt
      : turn.pending
    ).trim();
    const last = this.messages[this.messages.length - 1];
    if (heard && last?.role === "user") {
      this.messages.push({ role: "assistant", content: heard + " …(müşteri sözümü kesti)" });
    }
  }

  private finish() {
    if (this.ended) return;
    this.ended = true;
    this.out.end({ transfer: this.state.transfer });
  }
}

function log(st: CallState, event: string, data: unknown) {
  if (process.env.LOG_TOOLS !== "0") console.log(`[${st.callerPhone || "gizli"}] ${event}`, JSON.stringify(data));
}
