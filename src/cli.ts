import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { config, loadBusiness } from "./config.js";
import { createHalipratik, normalizePhone } from "./halipratik/index.js";
import { CallSession } from "./agent/session.js";
import type { CallState } from "./agent/tools.js";

/**
 * Telefon olmadan, terminalden yazışarak asistanı denemek için.
 * Kullanım: npm run chat -- 05321234567
 */
const phoneArg = process.argv[2] ?? "05320000000";

const state: CallState = {
  callerPhone: normalizePhone(phoneArg),
  customer: null,
  business: loadBusiness(),
  crm: createHalipratik(),
  timezone: config.timezone,
  now: () => new Date(),
  endRequested: false,
  transfer: null,
};

let done = false;
const session = new CallSession(state, {
  text: (token, last) => {
    stdout.write(token);
    if (last) stdout.write("\n");
  },
  end: ({ transfer }) => {
    done = true;
    console.log(transfer ? `\n[Görüşme çalışana aktarılıyor: ${transfer.reason} — ${transfer.summary}]` : "\n[Görüşme bitti]");
  },
});

const rl = readline.createInterface({ input: stdin, output: stdout });
const greeting = await session.start();
console.log(`[Arayan: ${state.callerPhone}, kayıt: ${state.customer ? state.customer.ad_soyad : "yok"}]\n`);
console.log(`Asistan: ${greeting}`);

while (!done) {
  const line = await rl.question("\nSiz: ");
  if (!line.trim()) continue;
  stdout.write("Asistan: ");
  await session.onUserSpeech(line);
}
rl.close();
