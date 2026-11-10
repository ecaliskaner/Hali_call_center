import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  CreatePickupInput,
  Customer,
  HalipratikClient,
  Order,
  SaveCustomerInput,
  Slot,
} from "./types.js";
import { normalizePhone } from "./types.js";

/**
 * Halıpratik bağlantısı hazır olana kadar kullanılan yerel sahte veritabanı (JSON dosyası).
 * Aynı arayüzü uyguladığı için asistanı uçtan uca test etmeye yarar.
 */

interface Driver {
  id: string;
  ad: string;
  bolgeler: string[];
  /** 1=Pazartesi ... 7=Pazar */
  calisma_gunleri: number[];
  saat_araliklari: string[];
  aralik_kapasitesi: number;
}

interface MockDb {
  soforler: Driver[];
  musteriler: Customer[];
  siparisler: (Order & { slot_id: string })[];
}

const SEED: MockDb = {
  soforler: [
    {
      id: "s1",
      ad: "Mehmet",
      bolgeler: ["Kadıköy", "Üsküdar", "Ataşehir"],
      calisma_gunleri: [1, 2, 3, 4, 5, 6],
      saat_araliklari: ["09:00-11:00", "11:00-13:00", "14:00-16:00", "16:00-18:00"],
      aralik_kapasitesi: 3,
    },
    {
      id: "s2",
      ad: "Hasan",
      bolgeler: ["Maltepe", "Kartal", "Ataşehir", "Ümraniye"],
      calisma_gunleri: [1, 2, 3, 4, 5, 6],
      saat_araliklari: ["10:00-12:00", "13:00-15:00", "15:00-17:00"],
      aralik_kapasitesi: 3,
    },
  ],
  musteriler: [],
  siparisler: [],
};

export class MockHalipratik implements HalipratikClient {
  private db: MockDb;

  constructor(private file: string, private now: () => Date = () => new Date()) {
    this.db = this.load();
  }

  private load(): MockDb {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as MockDb;
    } catch {
      const db = structuredClone(SEED);
      this.persist(db);
      return db;
    }
  }

  private persist(db = this.db) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  async findCustomerByPhone(phone: string): Promise<Customer | null> {
    const p = normalizePhone(phone);
    return this.db.musteriler.find((c) => c.telefon === p) ?? null;
  }

  async saveCustomer(input: SaveCustomerInput): Promise<Customer> {
    const tel = normalizePhone(input.telefon);
    let c = this.db.musteriler.find((x) => x.telefon === tel);
    if (c) {
      c.ad_soyad = input.ad_soyad || c.ad_soyad;
      if (input.adres) c.adres = input.adres;
      if (input.notlar) c.notlar = input.notlar;
    } else {
      c = {
        id: "m_" + crypto.randomUUID().slice(0, 8),
        ad_soyad: input.ad_soyad,
        telefon: tel,
        adres: input.adres,
        notlar: input.notlar,
        olusturma: this.now().toISOString(),
      };
      this.db.musteriler.push(c);
    }
    this.persist();
    return c;
  }

  async listAvailableSlots(q: { ilce: string; baslangic: string; gun_sayisi: number }): Promise<Slot[]> {
    const ilce = q.ilce.toLocaleLowerCase("tr");
    const drivers = this.db.soforler.filter((d) => d.bolgeler.some((b) => b.toLocaleLowerCase("tr") === ilce));
    const out: Slot[] = [];
    const start = new Date(q.baslangic + "T00:00:00Z");
    const nowMs = this.now().getTime();

    for (let i = 0; i < q.gun_sayisi; i++) {
      const day = new Date(start.getTime() + i * 86400000);
      const tarih = day.toISOString().slice(0, 10);
      const isoDow = ((day.getUTCDay() + 6) % 7) + 1;
      for (const d of drivers) {
        if (!d.calisma_gunleri.includes(isoDow)) continue;
        for (const aralik of d.saat_araliklari) {
          // Geçmiş saatleri gösterme (Türkiye UTC+3)
          const startHour = Number(aralik.slice(0, 2));
          const slotStartUtc = Date.parse(`${tarih}T${String(startHour).padStart(2, "0")}:00:00+03:00`);
          if (slotStartUtc < nowMs + 60 * 60 * 1000) continue;
          const id = `${tarih}|${aralik}|${d.id}`;
          const dolu = this.db.siparisler.filter((s) => s.slot_id === id && s.durum !== "iptal").length;
          const bos = d.aralik_kapasitesi - dolu;
          if (bos > 0) out.push({ id, tarih, saat_araligi: aralik, sofor_id: d.id, sofor_ad: d.ad, bos_kapasite: bos });
        }
      }
    }
    return out;
  }

  async createPickup(input: CreatePickupInput): Promise<Order> {
    const [tarih, aralik, soforId] = input.slot_id.split("|");
    const driver = this.db.soforler.find((d) => d.id === soforId);
    const customer = this.db.musteriler.find((c) => c.id === input.musteri_id);
    if (!driver || !tarih || !aralik) throw new Error("Geçersiz randevu saati (slot_id).");
    if (!customer) throw new Error("Müşteri bulunamadı; önce müşteri kaydı yapılmalı.");
    const dolu = this.db.siparisler.filter((s) => s.slot_id === input.slot_id && s.durum !== "iptal").length;
    if (dolu >= driver.aralik_kapasitesi) throw new Error("Bu saat aralığı az önce doldu, başka bir saat seçilmeli.");

    const order: Order & { slot_id: string } = {
      id: "S" + String(1000 + this.db.siparisler.length + 1),
      musteri_id: customer.id,
      durum: "alinacak",
      alim: { tarih, saat_araligi: aralik, sofor_ad: driver.ad },
      kalemler: input.kalemler,
      tahmini_tutar: input.tahmini_tutar,
      not: input.not,
      olusturma: this.now().toISOString(),
      slot_id: input.slot_id,
    };
    this.db.siparisler.push(order);
    this.persist();
    return strip(order);
  }

  async listOrders(customerId: string): Promise<Order[]> {
    return this.db.siparisler.filter((s) => s.musteri_id === customerId).map(strip);
  }

  async cancelOrder(orderId: string, customerId: string, reason?: string): Promise<Order> {
    const o = this.db.siparisler.find((s) => s.id === orderId && s.musteri_id === customerId);
    if (!o) throw new Error("Bu müşteriye ait böyle bir sipariş yok.");
    if (o.durum !== "alinacak") throw new Error("Halılar alındıktan sonra telefonla iptal yapılamaz.");
    o.durum = "iptal";
    if (reason) o.not = [o.not, `İptal nedeni: ${reason}`].filter(Boolean).join(" | ");
    this.persist();
    return strip(o);
  }
}

function strip(o: Order & { slot_id?: string }): Order {
  const { slot_id: _slot, ...rest } = o;
  return rest;
}
