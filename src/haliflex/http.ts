import type {
  CreatePickupInput,
  Customer,
  HaliflexClient,
  Order,
  SaveCustomerInput,
  Slot,
} from "./types.js";
import { normalizePhone } from "./types.js";

/**
 * Halıflex REST bağlantısı — ŞABLON.
 *
 * Halıflex'in herkese açık bir API dokümanı yok. Firmadan API erişimi (adres + anahtar)
 * ve uç nokta listesi alındığında sadece bu dosyadaki yollar ve alan eşlemeleri
 * (`toCustomer`, `toSlot`, `toOrder`) güncellenecek; asistanın geri kalanı değişmez.
 *
 * Halıflex API vermezse alternatif: aynı `HaliflexClient` arayüzünü Playwright ile
 * panel otomasyonu (giriş yap → formu doldur) olarak yazmak. README'de anlatılıyor.
 */
export class HttpHaliflex implements HaliflexClient {
  constructor(private baseUrl: string, private apiKey: string) {
    if (!baseUrl) throw new Error("HALIFLEX_BASE_URL tanımlı değil.");
  }

  private async req<T>(method: string, p: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl.replace(/\/$/, "") + p, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404 && method === "GET") return null as T;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Halıflex ${method} ${p} → ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  // ---- TODO: Aşağıdaki yolları Halıflex'in gerçek API'sine göre düzenleyin ----

  async findCustomerByPhone(phone: string): Promise<Customer | null> {
    const r = await this.req<any>("GET", `/customers?phone=${encodeURIComponent(normalizePhone(phone))}`);
    const item = Array.isArray(r) ? r[0] : r?.data?.[0] ?? r;
    return item ? toCustomer(item) : null;
  }

  async saveCustomer(input: SaveCustomerInput): Promise<Customer> {
    const existing = await this.findCustomerByPhone(input.telefon);
    const payload = {
      name: input.ad_soyad,
      phone: normalizePhone(input.telefon),
      district: input.adres?.ilce,
      neighborhood: input.adres?.mahalle,
      address: input.adres?.acik_adres,
      directions: input.adres?.tarif,
      note: input.notlar,
    };
    const r = existing
      ? await this.req<any>("PUT", `/customers/${existing.id}`, payload)
      : await this.req<any>("POST", `/customers`, payload);
    return toCustomer(r?.data ?? r);
  }

  async listAvailableSlots(q: { ilce: string; baslangic: string; gun_sayisi: number }): Promise<Slot[]> {
    const r = await this.req<any>(
      "GET",
      `/drivers/availability?district=${encodeURIComponent(q.ilce)}&from=${q.baslangic}&days=${q.gun_sayisi}`,
    );
    return (Array.isArray(r) ? r : r?.data ?? []).map(toSlot);
  }

  async createPickup(input: CreatePickupInput): Promise<Order> {
    const r = await this.req<any>("POST", `/orders`, {
      customer_id: input.musteri_id,
      slot_id: input.slot_id,
      items: input.kalemler.map((k) => ({ type: k.tur_kod, quantity: k.adet, area_m2: k.m2, note: k.not })),
      estimated_total: input.tahmini_tutar,
      note: input.not,
      source: "ai-phone",
    });
    return toOrder(r?.data ?? r);
  }

  async listOrders(customerId: string): Promise<Order[]> {
    const r = await this.req<any>("GET", `/orders?customer_id=${encodeURIComponent(customerId)}`);
    return (Array.isArray(r) ? r : r?.data ?? []).map(toOrder);
  }

  async cancelOrder(orderId: string, customerId: string, reason?: string): Promise<Order> {
    const orders = await this.listOrders(customerId);
    if (!orders.some((o) => o.id === orderId)) throw new Error("Bu müşteriye ait böyle bir sipariş yok.");
    const r = await this.req<any>("POST", `/orders/${encodeURIComponent(orderId)}/cancel`, { reason });
    return toOrder(r?.data ?? r);
  }
}

// ---- Alan eşlemeleri (Halıflex alan adlarına göre güncellenecek) ----

function toCustomer(x: any): Customer {
  return {
    id: String(x.id),
    ad_soyad: x.name ?? x.ad_soyad ?? "",
    telefon: normalizePhone(String(x.phone ?? x.telefon ?? "")),
    adres: x.address || x.acik_adres
      ? { ilce: x.district ?? "", mahalle: x.neighborhood, acik_adres: x.address ?? x.acik_adres, tarif: x.directions }
      : undefined,
    notlar: x.note,
    olusturma: x.created_at ?? new Date().toISOString(),
  };
}

function toSlot(x: any): Slot {
  return {
    id: String(x.id),
    tarih: x.date,
    saat_araligi: x.window ?? `${x.start}-${x.end}`,
    sofor_id: String(x.driver_id),
    sofor_ad: x.driver_name ?? "",
    bos_kapasite: Number(x.remaining ?? 1),
  };
}

function toOrder(x: any): Order {
  return {
    id: String(x.id),
    musteri_id: String(x.customer_id),
    durum: x.status,
    alim: { tarih: x.pickup_date, saat_araligi: x.pickup_window, sofor_ad: x.driver_name ?? "" },
    kalemler: (x.items ?? []).map((i: any) => ({ tur_kod: i.type, adet: i.quantity, m2: i.area_m2, not: i.note })),
    tahmini_tutar: x.estimated_total,
    not: x.note,
    olusturma: x.created_at ?? "",
  };
}
