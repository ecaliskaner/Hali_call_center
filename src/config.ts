import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Eksik ortam değişkeni: ${name}`);
  }
  return v;
}

export const config = {
  port: Number(env("PORT", "8080")),
  /** Twilio'nun ulaşacağı public adres, ör. https://hali.example.com (sonunda / yok) */
  publicUrl: env("PUBLIC_URL", "http://localhost:8080").replace(/\/$/, ""),
  /** WebSocket URL'ine eklenen gizli anahtar; sadece Twilio'nun bağlanabilmesi için. */
  relaySecret: env("RELAY_SECRET", "degistir-beni"),
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? "",
  /** Asistan "insana aktar" dediğinde aranacak numara (E.164, ör. +902120000000) */
  transferNumber: process.env.TRANSFER_NUMBER ?? "",

  claudeModel: env("CLAUDE_MODEL", "claude-opus-5-5"),
  /** Telefon görüşmesinde gecikme önemli: varsayılan "low". */
  claudeEffort: env("CLAUDE_EFFORT", "low") as "low" | "medium" | "high" | "xhigh" | "max",

  tts: {
    provider: env("TTS_PROVIDER", "ElevenLabs"),
    /** ElevenLabs ses kimliği (Türkçe, doğal bir kadın/erkek ses seçin). Model/ayar eklenebilir: "voiceId-flash_v2_5-1.0_0.8_0.8" */
    voice: env("TTS_VOICE", ""),
    language: env("TTS_LANGUAGE", "tr-TR"),
  },
  stt: {
    provider: env("STT_PROVIDER", "Deepgram"),
    speechModel: env("STT_MODEL", "nova-3-general"),
  },

  haliflex: {
    mode: env("HALIFLEX_MODE", "mock") as "mock" | "http",
    baseUrl: process.env.HALIFLEX_BASE_URL ?? "",
    apiKey: process.env.HALIFLEX_API_KEY ?? "",
    mockFile: env("HALIFLEX_MOCK_FILE", "data/haliflex-mock.json"),
  },

  timezone: env("TZ_NAME", "Europe/Istanbul"),
  callLogDir: env("CALL_LOG_DIR", "data/calls"),
};

// ---- İşletme bilgileri (config/business.json) ----

const PriceItem = z.object({
  kod: z.string(),
  ad: z.string(),
  birim: z.enum(["m2", "adet"]),
  fiyat: z.number().positive(),
});

const Business = z.object({
  isletme: z.object({
    ad: z.string(),
    asistan_adi: z.string(),
    sehir: z.string(),
    telefon: z.string(),
    calisma_saatleri: z.string(),
    kayit_bildirimi: z.string().optional(),
  }),
  hizmet_bolgeleri: z.array(z.string()),
  fiyatlar: z.array(PriceItem).min(1),
  kurallar: z.object({
    para_birimi: z.string(),
    minimum_siparis_tutari: z.number().nonnegative(),
    ucretsiz_servis: z.boolean(),
    teslim_suresi_gun: z.string(),
    odeme_secenekleri: z.string(),
    olcum_notu: z.string(),
  }),
  kampanyalar: z.array(z.string()),
  pazarlama_noktalari: z.array(z.string()),
  sik_sorulanlar: z.array(z.object({ soru: z.string(), cevap: z.string() })),
});

export type Business = z.infer<typeof Business>;
export type PriceItem = z.infer<typeof PriceItem>;

export function loadBusiness(file = env("BUSINESS_FILE", "config/business.json")): Business {
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  return Business.parse(raw);
}
