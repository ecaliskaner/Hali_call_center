import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Business } from "../config.js";
import { quote } from "../pricing.js";
import type { Customer, HaliflexClient } from "../haliflex/types.js";

/** Bir aramaya ait durum. Araçlar sadece arayan kişinin kendi kaydı üzerinde çalışır. */
export interface CallState {
  callerPhone: string;
  customer: Customer | null;
  business: Business;
  crm: HaliflexClient;
  timezone: string;
  now: () => Date;
  endRequested: boolean;
  transfer: { reason: string; summary: string } | null;
}

interface ToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, st: CallState) => Promise<unknown>;
}

function tool<S extends z.ZodTypeAny>(d: ToolDef<S>): ToolDef<S> {
  return d;
}

const Adres = z.object({
  ilce: z.string().describe("İlçe, ör. Kadıköy"),
  mahalle: z.string().optional(),
  acik_adres: z.string().describe("Sokak/cadde, bina no, daire no"),
  tarif: z.string().optional().describe("Varsa adres tarifi, ör. eczanenin üstü"),
});

const Kalem = z.object({
  tur_kod: z.string().describe("Fiyat listesindeki halı türü kodu, ör. makine, shaggy, yun_el"),
  adet: z.number().int().positive(),
  m2: z.number().positive().optional().describe("Halı başına yaklaşık metrekare (2x3 halı = 6). Bilinmiyorsa boş bırak."),
  not: z.string().optional(),
});

function todayIso(st: CallState): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: st.timezone }).format(st.now());
}

const TOOLS = [
  tool({
    name: "musteri_kaydet",
    description:
      "Arayan müşteriyi Halıflex'e kaydeder ya da bilgilerini günceller (ad soyad, adres). Randevu oluşturmadan önce müşteri kaydı olmalı. Bilgileri müşteriye teyit ettirdikten sonra çağır.",
    schema: z.object({
      ad_soyad: z.string(),
      adres: Adres.optional(),
      iletisim_telefonu: z
        .string()
        .optional()
        .describe("Sadece müşteri arandığı numaradan FARKLI bir numara verirse; yoksa boş bırak."),
      notlar: z.string().optional(),
    }),
    run: async (i, st) => {
      if (i.adres && !inServiceArea(st.business, i.adres.ilce)) {
        return { hata: `${i.adres.ilce} hizmet bölgemiz dışında.`, hizmet_bolgeleri: st.business.hizmet_bolgeleri };
      }
      const tel = st.callerPhone || i.iletisim_telefonu;
      if (!tel) return { hata: "Numara gizli; müşteriden bir iletişim telefonu iste." };
      const notlar = [i.notlar, i.iletisim_telefonu && st.callerPhone ? `İletişim tel: ${i.iletisim_telefonu}` : undefined]
        .filter(Boolean)
        .join(" | ");
      const c = await st.crm.saveCustomer({ ad_soyad: i.ad_soyad, telefon: tel, adres: i.adres, notlar: notlar || undefined });
      st.customer = c;
      if (!st.callerPhone) st.callerPhone = c.telefon;
      return { tamam: true, musteri: { ad_soyad: c.ad_soyad, adres: c.adres } };
    },
  }),

  tool({
    name: "fiyat_hesapla",
    description:
      "Halı türü, adet ve yaklaşık ölçüye göre tahmini fiyat hesaplar (kampanya ve minimum tutar dahil). Fiyat söylemeden önce mutlaka bunu çağır.",
    schema: z.object({ kalemler: z.array(Kalem).min(1) }),
    run: async (i, st) => quote(st.business, i.kalemler),
  }),

  tool({
    name: "musait_saatleri_getir",
    description:
      "Müşterinin ilçesi için şoförlerin boş alım saatlerini Halıflex'ten getirir. Sonuçtaki slot_id değerini randevu_olustur'a ver; müşteriye slot_id söyleme.",
    schema: z.object({
      ilce: z.string(),
      baslangic_tarihi: z.string().optional().describe("YYYY-MM-DD. Boşsa bugünden başlar."),
      gun_sayisi: z.number().int().min(1).max(7).optional().describe("Kaç gün ileriye bakılsın (varsayılan 3)"),
    }),
    run: async (i, st) => {
      if (!inServiceArea(st.business, i.ilce)) {
        return { hata: `${i.ilce} hizmet bölgemiz dışında.`, hizmet_bolgeleri: st.business.hizmet_bolgeleri };
      }
      const slots = await st.crm.listAvailableSlots({
        ilce: i.ilce,
        baslangic: i.baslangic_tarihi ?? todayIso(st),
        gun_sayisi: i.gun_sayisi ?? 3,
      });
      // Modelin bağlamını şişirmemek için her gün için en fazla 4 aralık göster
      const perDay = new Map<string, typeof slots>();
      for (const s of slots) {
        const arr = perDay.get(s.tarih) ?? [];
        if (arr.length < 4 && !arr.some((x) => x.saat_araligi === s.saat_araligi)) arr.push(s);
        perDay.set(s.tarih, arr);
      }
      const out = [...perDay.values()].flat().map((s) => ({
        slot_id: s.id,
        gun: gunAdi(s.tarih, st.timezone),
        tarih: s.tarih,
        saat_araligi: s.saat_araligi,
      }));
      return out.length ? { musait: out } : { musait: [], not: "Bu aralıkta boş saat yok; daha ileri bir tarihe bak." };
    },
  }),

  tool({
    name: "randevu_olustur",
    description:
      "Halı alım randevusunu Halıflex'e kaydeder ve şoföre atar. Önce musteri_kaydet ile adres kaydedilmiş ve müşteri özeti onaylamış olmalı.",
    schema: z.object({
      slot_id: z.string(),
      kalemler: z.array(Kalem).min(1),
      tahmini_tutar: z.number().optional(),
      not: z.string().optional().describe("Şoför için not, ör. 'zile basmayın, arayın'"),
    }),
    run: async (i, st) => {
      if (!st.customer) return { hata: "Önce musteri_kaydet ile müşteri ve adres kaydedilmeli." };
      if (!st.customer.adres) return { hata: "Müşterinin adresi kayıtlı değil; adresi alıp musteri_kaydet çağır." };
      const o = await st.crm.createPickup({
        musteri_id: st.customer.id,
        slot_id: i.slot_id,
        kalemler: i.kalemler,
        tahmini_tutar: i.tahmini_tutar,
        not: i.not,
      });
      return {
        tamam: true,
        siparis_no: o.id,
        gun: gunAdi(o.alim.tarih, st.timezone),
        tarih: o.alim.tarih,
        saat_araligi: o.alim.saat_araligi,
        sofor: o.alim.sofor_ad,
      };
    },
  }),

  tool({
    name: "siparisleri_getir",
    description: "Arayan müşterinin siparişlerini ve durumlarını getirir (alınacak, yıkamada, hazır, teslim edildi...).",
    schema: z.object({}),
    run: async (_i, st) => {
      if (!st.customer) return { hata: "Bu numaraya kayıtlı müşteri yok." };
      const orders = await st.crm.listOrders(st.customer.id);
      return { siparisler: orders.slice(-5) };
    },
  }),

  tool({
    name: "randevu_iptal",
    description: "Arayan müşterinin henüz alınmamış bir randevusunu iptal eder. Önce müşteriden onay al.",
    schema: z.object({ siparis_no: z.string(), neden: z.string().optional() }),
    run: async (i, st) => {
      if (!st.customer) return { hata: "Bu numaraya kayıtlı müşteri yok." };
      const o = await st.crm.cancelOrder(i.siparis_no, st.customer.id, i.neden);
      return { tamam: true, siparis_no: o.id, durum: o.durum };
    },
  }),

  tool({
    name: "insana_aktar",
    description:
      "Görüşmeyi firmadaki bir çalışana aktarır. Şikâyet, hasar/kayıp, çözemediğin soru veya müşteri bir insanla görüşmek isterse kullan. Çağırmadan önce 'Sizi hemen arkadaşıma aktarıyorum' de.",
    schema: z.object({
      neden: z.string(),
      ozet: z.string().describe("Çalışan için görüşmenin kısa özeti"),
    }),
    run: async (i, st) => {
      st.transfer = { reason: i.neden, summary: i.ozet };
      return { tamam: true, not: "Konuşmanı tek kısa cümleyle bitir; hat aktarılacak." };
    },
  }),

  tool({
    name: "gorusmeyi_bitir",
    description: "Müşteri vedalaştıktan sonra görüşmeyi sonlandırır. Veda cümleni bu araçtan ÖNCE söyle.",
    schema: z.object({ sonuc: z.string().describe("Görüşme sonucu, ör. 'randevu alındı', 'fiyat bilgisi verildi'") }),
    run: async (_i, st) => {
      st.endRequested = true;
      return { tamam: true };
    },
  }),
];

function inServiceArea(b: Business, ilce: string): boolean {
  const x = ilce.trim().toLocaleLowerCase("tr");
  return b.hizmet_bolgeleri.some((r) => r.toLocaleLowerCase("tr") === x);
}

function gunAdi(isoDate: string, tz: string): string {
  return new Intl.DateTimeFormat("tr-TR", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(
    new Date(isoDate + "T12:00:00Z"),
  );
}

/** Claude'a gönderilecek araç tanımları (Zod şemalarından JSON Schema üretilir). */
export const toolDefinitions: Anthropic.Beta.BetaTool[] = TOOLS.map((t) => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(t.schema) as Record<string, unknown>;
  return {
    name: t.name,
    description: t.description,
    input_schema: { type: "object", ...schema } as Anthropic.Beta.BetaTool.InputSchema,
  };
});

/** Bir araç çağrısını doğrular ve çalıştırır. Hatalar modele is_error olarak döner. */
export async function runTool(
  name: string,
  input: unknown,
  st: CallState,
): Promise<{ content: string; isError: boolean }> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { content: `Bilinmeyen araç: ${name}`, isError: true };
  const parsed = t.schema.safeParse(input);
  if (!parsed.success) return { content: `Geçersiz girdi: ${parsed.error.message}`, isError: true };
  try {
    const result = await (t.run as (i: unknown, s: CallState) => Promise<unknown>)(parsed.data, st);
    const isError = typeof result === "object" && result !== null && "hata" in result;
    return { content: JSON.stringify(result), isError };
  } catch (err) {
    return { content: `Sistem hatası: ${(err as Error).message}`, isError: true };
  }
}
