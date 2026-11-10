# Halı Yıkama Telefon Asistanı

Halı yıkama firmasının telefonuna bağlanan, doğal Türkçe sesle konuşan yapay zekâ asistanı.

- Müşteriyi karşılar, **fiyat bilgisi** verir (fiyat listesinden hesaplar, uydurmaz)
- **Ad, adres, halı türü/adedi** alır ve teyit eder
- **Şoför müsaitliğine** bakıp alım randevusu oluşturur
- Firmanın farklarını ve kampanyalarını anlatarak **satış/pazarlama** yapar
- Kayıtlı müşteriyi numarasından tanır, **sipariş durumunu** söyler, randevu iptal eder
- Şikâyet, hasar veya "insanla görüşmek istiyorum" durumunda **çalışana aktarır**
- Tüm müşteri/randevu bilgileri **Halıpratik'e yazılır ve Halıpratik'ten okunur**

## Nasıl çalışıyor

```
Müşteri arar
   │
   ▼
Twilio numarası ──POST /voice──► bu sunucu (TwiML döner)
   │
   │  Twilio ConversationRelay:
   │   - konuşmayı yazıya çevirir (Deepgram, Türkçe)
   │   - cevabı ElevenLabs ile gerçekçi sese çevirir
   │   - araya girmeyi (söz kesme) yönetir
   ▼
WebSocket /relay ◄──► CallSession (Claude)
                          │  araçlar:
                          ├─ musteri_kaydet ─────┐
                          ├─ musait_saatleri_getir├──► Halıpratik (API / panel)
                          ├─ randevu_olustur ─────┤
                          ├─ siparisleri_getir ───┤
                          ├─ randevu_iptal ───────┘
                          ├─ fiyat_hesapla  (config/business.json)
                          ├─ insana_aktar   (→ TRANSFER_NUMBER'a Dial)
                          └─ gorusmeyi_bitir
```

| Dosya | Görev |
|---|---|
| `config/business.json` | Firma adı, **fiyat listesi**, hizmet bölgeleri, kampanyalar, **pazarlama noktaları**, SSS. Asistan sadece buradakini söyler. |
| `src/agent/prompt.ts` | Asistanın kişiliği ve telefon konuşma kuralları |
| `src/agent/tools.ts` | Asistanın kullanabildiği araçlar |
| `src/agent/session.ts` | Görüşme döngüsü (Claude akışı, söz kesme, aktarma) |
| `src/halipratik/` | Halıpratik bağlantısı: `mock.ts` (deneme), `http.ts` (API şablonu) |
| `src/server.ts` | Twilio webhook + WebSocket sunucusu |
| `src/cli.ts` | Telefonsuz, yazışarak deneme |

## Hızlı deneme (telefonsuz)

```bash
npm install
```

```bash
cp .env.example .env   # ANTHROPIC_API_KEY'i doldurun
```

```bash
npm run chat -- 05321234567
```

Terminalde müşteri gibi yazın ("Merhaba, halı yıkatmak istiyorum, fiyat ne kadar?"). Randevular `data/halipratik-mock.json` dosyasına yazılır; aynı numarayla tekrar denerseniz asistan sizi tanır.

## Telefona bağlama

1. **Twilio hesabı** açın, bir numara alın. Türkiye'deki mevcut sabit/mobil hattınızı bu numaraya **yönlendirin** (operatörden "çağrı yönlendirme"), ya da SIP trunk (ör. Netgsm) ile Twilio Elastic SIP'e bağlayın. Böylece müşteriler eski numaranızı aramaya devam eder.
2. Twilio Console → **Voice → ConversationRelay** özelliğini etkinleştirin (AI/ML özellikleri onayı).
3. **ElevenLabs** ses kütüphanesinden doğal, Türkçe konuşan bir ses seçin, kimliğini `TTS_VOICE`'a yazın. Ses gerçekçiliğini en çok bu seçim belirler; birkaç sesi deneyin.
4. Sunucuyu https erişilebilir bir yere kurun (Render, Railway, Fly.io, VPS). Denemede: `ngrok http 8080`.
5. `.env`'de `PUBLIC_URL`, `RELAY_SECRET`, `TWILIO_AUTH_TOKEN`, `TRANSFER_NUMBER` değerlerini doldurun.
6. Twilio numarasının **"A call comes in"** webhook'unu `https://ALAN-ADINIZ/voice` (HTTP POST) yapın.

```bash
npm run build && npm start
```

## Halıpratik bağlantısı

Halıpratik'in hazır bir API dokümanı yok. Halıpratik'ten neler istendiği [docs/halipratik-entegrasyon-ihtiyaclari.md](docs/halipratik-entegrasyon-ihtiyaclari.md) dosyasında; bu dosya doğrudan Halıpratik'e gönderilebilir. İki yol var:

1. **API erişimi (önerilen):** Halıpratik o listedeki uç noktaları açar. `src/halipratik/http.ts` zaten o listeye göre yazıldı; adlar farklı çıkarsa sadece bu dosyadaki yollar ve alan eşlemeleri düzenlenir, `HALIPRATIK_MODE=http` yapılır. Asistanın geri kalanı değişmez.
2. **Panel otomasyonu:** API yoksa aynı `HalipratikClient` arayüzü (`src/halipratik/types.ts`) Playwright ile yazılır: sunucu Halıpratik paneline giriş yapıp formu doldurur ve şoför takvimini okur. Daha kırılgandır (panel değişirse bozulur) ama çalışır.

O zamana kadar `HALIPRATIK_MODE=mock` ile her şey yerel bir dosyada çalışır. Şoförler ve saat aralıkları `src/halipratik/mock.ts` içindeki `SEED`'de tanımlı.

## Firma bilgilerini düzenleme

`config/business.json` içindeki değerler **örnektir**: firma adı, asistan adı, fiyatlar, bölgeler, kampanyalar ve "farklarımız" listesini kendinize göre değiştirin. 3+ halıda %10 indirim kuralı `src/pricing.ts` içinde; farklı kampanyanız varsa orayı da güncelleyin.

## Gecikme ve maliyet

- Varsayılan model `claude-opus-5-5`, `CLAUDE_EFFORT=low` (telefonda cevap hızı önemli).
- Daha hızlı cevap için: `CLAUDE_FAST=1` (fast mod, daha pahalı) ya da `CLAUDE_MODEL=claude-haiku-5-5` (çok daha ucuz ve hızlı, kalite biraz düşebilir). Gerçek aramalarla deneyip karar verin.
- Sistem talimatı ve araçlar önbelleğe alınır (prompt caching), her aramada tekrar ücretlendirilmez.
- Bir istek güvenlik filtresine takılırsa sunucu tarafı yedek model devreye girer (`fallbacks: "default"`).

## Güvenlik ve yasal notlar

- Asistan sadece **arayan numaranın kendi kaydı** üzerinde işlem yapar; başkasının bilgisini vermez, başkasının siparişini iptal edemez.
- "Yapay zekâ mısın?" sorusuna dürüst cevap verir ve isterse çalışana aktarır. Gerçek insan olduğunu iddia etmez.
- Karşılamada görüşme kaydı bildirimi var (`kayit_bildirimi`). KVKK aydınlatma metninizi web sitenizde yayınlayın; görüşme dökümleri `data/calls/` altına yazılır, saklama süresini belirleyin.
- Twilio istekleri imza ile, WebSocket bağlantısı `RELAY_SECRET` ile doğrulanır.

## Test

```bash
npm test
```
