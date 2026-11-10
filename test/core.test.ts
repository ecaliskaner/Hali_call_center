import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBusiness } from "../src/config.js";
import { quote } from "../src/pricing.js";
import { MockHalipratik } from "../src/halipratik/mock.js";
import { normalizePhone } from "../src/halipratik/types.js";
import { runTool, toolDefinitions, type CallState } from "../src/agent/tools.js";

const business = loadBusiness("config/business.json");

test("telefon normalizasyonu", () => {
  assert.equal(normalizePhone("0532 123 45 67"), "+905321234567");
  assert.equal(normalizePhone("+90 532 123 45 67"), "+905321234567");
  assert.equal(normalizePhone("5321234567"), "+905321234567");
});

test("fiyat: 3 makine halısı %10 indirim", () => {
  const q = quote(business, [{ tur_kod: "makine", adet: 3, m2: 6 }]);
  assert.equal(q.ara_toplam, 1080);
  assert.equal(q.indirim, 108);
  assert.equal(q.toplam, 972);
});

test("fiyat: minimum tutar ve bilinmeyen tür", () => {
  const q = quote(business, [{ tur_kod: "yorgan", adet: 1 }, { tur_kod: "xyz", adet: 1 }]);
  assert.equal(q.toplam, business.kurallar.minimum_siparis_tutari);
  assert.ok(q.minimum_uygulandi);
  assert.deepEqual(q.bilinmeyen_turler, ["xyz"]);
});

function freshState(now = new Date("2026-11-10T07:00:00Z")): CallState {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hali-")), "db.json");
  return {
    callerPhone: "+905321234567",
    customer: null,
    business,
    crm: new MockHalipratik(file, () => now),
    timezone: "Europe/Istanbul",
    now: () => now,
    endRequested: false,
    transfer: null,
  };
}

test("araç tanımları geçerli JSON Schema üretir", () => {
  for (const t of toolDefinitions) assert.equal((t.input_schema as any).type, "object", t.name);
});

test("uçtan uca: kayıt → müsaitlik → randevu → sipariş → iptal", async () => {
  const st = freshState();
  const kayit = await runTool("musteri_kaydet", { ad_soyad: "Ayşe Yılmaz", adres: { ilce: "Kadıköy", acik_adres: "Moda Cd. 5/3" } }, st);
  assert.equal(kayit.isError, false);
  assert.ok(st.customer);

  const slots = JSON.parse((await runTool("musait_saatleri_getir", { ilce: "Kadıköy" }, st)).content);
  assert.ok(slots.musait.length > 0);

  const r = JSON.parse(
    (await runTool("randevu_olustur", { slot_id: slots.musait[0].slot_id, kalemler: [{ tur_kod: "makine", adet: 2 }] }, st)).content,
  );
  assert.equal(r.tamam, true);

  const list = JSON.parse((await runTool("siparisleri_getir", {}, st)).content);
  assert.equal(list.siparisler.length, 1);

  const iptal = JSON.parse((await runTool("randevu_iptal", { siparis_no: r.siparis_no }, st)).content);
  assert.equal(iptal.durum, "iptal");

  // Aynı numarayla tekrar arayan tanınır
  assert.equal((await st.crm.findCustomerByPhone("05321234567"))?.ad_soyad, "Ayşe Yılmaz");
});

test("hizmet bölgesi dışı reddedilir, geçersiz girdi hata döner", async () => {
  const st = freshState();
  const r = await runTool("musait_saatleri_getir", { ilce: "Beşiktaş" }, st);
  assert.equal(r.isError, true);
  const bad = await runTool("fiyat_hesapla", { kalemler: [] }, st);
  assert.equal(bad.isError, true);
});

test("başka müşterinin siparişi iptal edilemez", async () => {
  const st = freshState();
  await runTool("musteri_kaydet", { ad_soyad: "A", adres: { ilce: "Kadıköy", acik_adres: "x" } }, st);
  const slots = JSON.parse((await runTool("musait_saatleri_getir", { ilce: "Kadıköy" }, st)).content);
  const r = JSON.parse((await runTool("randevu_olustur", { slot_id: slots.musait[0].slot_id, kalemler: [{ tur_kod: "makine", adet: 1 }] }, st)).content);
  st.customer = await st.crm.saveCustomer({ ad_soyad: "B", telefon: "05559998877" });
  const res = await runTool("randevu_iptal", { siparis_no: r.siparis_no }, st);
  assert.equal(res.isError, true);
});
