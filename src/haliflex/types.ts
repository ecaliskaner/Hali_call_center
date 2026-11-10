/**
 * Halıflex ile konuşan katmanın ortak arayüzü.
 * Asistan sadece bu arayüzü bilir; arkada sahte (mock) veri mi, Halıflex API'si mi,
 * yoksa panel otomasyonu mu olduğu fark etmez.
 */

export interface Address {
  ilce: string;
  mahalle?: string;
  acik_adres: string;
  tarif?: string;
}

export interface Customer {
  id: string;
  ad_soyad: string;
  telefon: string;
  adres?: Address;
  notlar?: string;
  olusturma: string;
}

export interface CarpetItem {
  tur_kod: string;
  adet: number;
  m2?: number;
  not?: string;
}

/** Şoförün belli bir gün ve saat aralığındaki boş alım kapasitesi. */
export interface Slot {
  id: string;
  tarih: string; // YYYY-MM-DD
  saat_araligi: string; // "10:00-12:00"
  sofor_id: string;
  sofor_ad: string;
  bos_kapasite: number;
}

export type OrderStatus = "alinacak" | "alindi" | "yikamada" | "hazir" | "teslimatta" | "teslim_edildi" | "iptal";

export interface Order {
  id: string;
  musteri_id: string;
  durum: OrderStatus;
  alim: { tarih: string; saat_araligi: string; sofor_ad: string };
  kalemler: CarpetItem[];
  tahmini_tutar?: number;
  not?: string;
  olusturma: string;
}

export interface SaveCustomerInput {
  ad_soyad: string;
  telefon: string;
  adres?: Address;
  notlar?: string;
}

export interface CreatePickupInput {
  musteri_id: string;
  slot_id: string;
  kalemler: CarpetItem[];
  tahmini_tutar?: number;
  not?: string;
}

export interface HaliflexClient {
  findCustomerByPhone(phone: string): Promise<Customer | null>;
  saveCustomer(input: SaveCustomerInput): Promise<Customer>;
  listAvailableSlots(q: { ilce: string; baslangic: string; gun_sayisi: number }): Promise<Slot[]>;
  createPickup(input: CreatePickupInput): Promise<Order>;
  listOrders(customerId: string): Promise<Order[]>;
  cancelOrder(orderId: string, customerId: string, reason?: string): Promise<Order>;
}

/** Türkiye telefon numaralarını tek biçime getirir: +905xxxxxxxxx */
export function normalizePhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  if (digits.startsWith("90") && digits.length === 12) return "+" + digits;
  if (digits.startsWith("0") && digits.length === 11) return "+9" + digits;
  if (digits.length === 10) return "+90" + digits;
  return p.startsWith("+") ? "+" + digits : digits;
}
