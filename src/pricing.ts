import type { Business } from "./config.js";

export interface PriceLineInput {
  tur_kod: string;
  adet: number;
  /** Halı başına yaklaşık m² (ör. 2x3 halı için 6). Adet bazlı ürünlerde boş bırakılır. */
  m2?: number;
}

export interface PriceQuote {
  satirlar: { ad: string; adet: number; toplam_m2?: number; birim_fiyat: number; birim: string; tutar: number }[];
  ara_toplam: number;
  indirim: number;
  indirim_aciklama?: string;
  toplam: number;
  minimum_uygulandi: boolean;
  para_birimi: string;
  not: string;
  bilinmeyen_turler: string[];
}

/**
 * Tahmini fiyat hesabı. Asistan fiyatı asla kendisi hesaplamaz, bu fonksiyonu araç olarak çağırır.
 * Kampanya kuralı (3+ halıda %10) burada kodlanmıştır; farklı kampanyanız varsa burayı değiştirin.
 */
export function quote(business: Business, lines: PriceLineInput[]): PriceQuote {
  const satirlar: PriceQuote["satirlar"] = [];
  const bilinmeyen: string[] = [];
  let halıAdedi = 0;

  for (const l of lines) {
    const item = business.fiyatlar.find((f) => f.kod === l.tur_kod);
    if (!item) {
      bilinmeyen.push(l.tur_kod);
      continue;
    }
    if (item.birim === "m2") {
      const m2 = l.m2 && l.m2 > 0 ? l.m2 : 6; // ölçü bilinmiyorsa ortalama 2x3 halı varsay
      const toplamM2 = round(m2 * l.adet);
      satirlar.push({ ad: item.ad, adet: l.adet, toplam_m2: toplamM2, birim_fiyat: item.fiyat, birim: "m²", tutar: round(toplamM2 * item.fiyat) });
      halıAdedi += l.adet;
    } else {
      satirlar.push({ ad: item.ad, adet: l.adet, birim_fiyat: item.fiyat, birim: "adet", tutar: round(l.adet * item.fiyat) });
    }
  }

  const ara = round(satirlar.reduce((s, x) => s + x.tutar, 0));
  let indirim = 0;
  let indirimAciklama: string | undefined;
  if (halıAdedi >= 3) {
    indirim = round(ara * 0.1);
    indirimAciklama = "Üç ve üzeri halıda yüzde on indirim";
  }
  let toplam = round(ara - indirim);
  const min = business.kurallar.minimum_siparis_tutari;
  const minimumUygulandi = satirlar.length > 0 && toplam < min;
  if (minimumUygulandi) toplam = min;

  return {
    satirlar,
    ara_toplam: ara,
    indirim,
    indirim_aciklama: indirimAciklama,
    toplam,
    minimum_uygulandi: minimumUygulandi,
    para_birimi: business.kurallar.para_birimi,
    not: business.kurallar.olcum_notu,
    bilinmeyen_turler: bilinmeyen,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
