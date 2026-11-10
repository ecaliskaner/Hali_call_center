# Halıpratik Entegrasyon İhtiyaç Listesi

**Amaç:** Firmamızın telefonuna bağlanan sesli asistan müşteriyle konuşurken Halıpratik'teki müşteri, şoför ve sipariş bilgilerini okuyacak, yeni müşteri ve alım siparişlerini Halıpratik'e yazacak. Asistanın yaptığı her kayıt panelde normal bir sipariş gibi görünecek.

Aşağıdaki uç noktaların adları ve alan isimleri öneridir. Sizde farklı adlar varsa sorun değil; dokümanınızı paylaşmanız yeterli, biz kendi tarafımızda uyarlarız.

## 1. Genel

| Konu | İhtiyaç |
|---|---|
| Biçim | HTTPS üzerinden JSON (REST) |
| Kimlik doğrulama | Firmamıza özel API anahtarı, istek başlığında: `Authorization: Bearer <anahtar>`. Anahtar sadece bizim firmamızın verilerine erişebilmeli. |
| Test | Mümkünse bir test hesabı veya test ortamı (gerçek müşteriler etkilenmeden denemek için) |
| Hız | Telefonda müşteri beklediği için cevaplar **1 saniyenin altında** dönmeli |
| Telefon biçimi | `+905321234567` (biz bu biçimde göndereceğiz; sizde `0532...` ise biz çeviririz, hangisi olduğunu belirtmeniz yeterli) |
| Tarih biçimi | Tarih `YYYY-AA-GG` (ör. `2026-11-12`), saat aralığı `"10:00-12:00"`, saat dilimi Türkiye |
| Hata cevabı | Uygun HTTP kodu + `{"error": {"code": "...", "message": "..."}}` |
| Kayıt kaynağı | Siparişlerde `source: "ai-phone"` alanını saklayabilirseniz panelde "telefon asistanından geldi" diye ayırt edebiliriz |

## 2. Zorunlu uç noktalar

### 2.1 Telefon numarasıyla müşteri bulma
Arama gelir gelmez arayanı tanımak için.

`GET /customers?phone=+905321234567`

```json
[
  {
    "id": "123",
    "name": "Ayşe Yılmaz",
    "phone": "+905321234567",
    "district": "Kadıköy",
    "neighborhood": "Caferağa",
    "address": "Moda Cd. No:5 D:3",
    "directions": "Eczanenin üstü",
    "note": "",
    "created_at": "2026-11-10T09:00:00+03:00"
  }
]
```
Bulunamazsa boş liste `[]` veya `404`.

### 2.2 Müşteri ekleme ve güncelleme

`POST /customers` (yeni) ve `PUT /customers/{id}` (güncelleme)

```json
{
  "name": "Ayşe Yılmaz",
  "phone": "+905321234567",
  "district": "Kadıköy",
  "neighborhood": "Caferağa",
  "address": "Moda Cd. No:5 D:3",
  "directions": "Eczanenin üstü",
  "note": "İletişim tel: 05551112233"
}
```
Cevap: kaydedilen müşteri (2.1'deki biçimde).

### 2.3 Şoför müsaitliği (en önemli kısım)
Asistan müşteriye "Salı 10-12 arası uygun mu?" diyebilmek için ilçeye göre **boş alım saatlerini** görmeli.

`GET /drivers/availability?district=Kadıköy&from=2026-11-12&days=3`

```json
[
  {
    "id": "2026-11-12|10:00-12:00|7",
    "date": "2026-11-12",
    "window": "10:00-12:00",
    "driver_id": "7",
    "driver_name": "Mehmet",
    "remaining": 2
  }
]
```
- `id`: bu saat aralığını tanımlayan değer; sipariş oluştururken geri göndereceğiz.
- `remaining`: o aralıkta şoförün alabileceği kalan adres sayısı.

**Sizde böyle bir müsaitlik hesabı yoksa** bize şu iki bilgiyi vermeniz yeterli, hesabı biz yaparız:
1. `GET /drivers`: şoför listesi, her şoförün çalıştığı ilçeler, çalışma günleri, saat aralıkları ve aralık başına kaç adrese gidebildiği
2. `GET /orders?date=2026-11-12`: o güne atanmış alımlar (şoför ve saat aralığıyla birlikte)

### 2.4 Alım siparişi oluşturma

`POST /orders`

```json
{
  "customer_id": "123",
  "slot_id": "2026-11-12|10:00-12:00|7",
  "items": [
    { "type": "makine", "quantity": 2, "area_m2": 6, "note": "" },
    { "type": "yorgan", "quantity": 1 }
  ],
  "estimated_total": 1070,
  "note": "Zile basmayın, arayın",
  "source": "ai-phone"
}
```
- `slot_id` yerine `driver_id` + `pickup_date` + `pickup_window` de olabilir.
- Aralık bu arada dolmuşsa `409` dönmesi yeterli; asistan müşteriye başka saat önerir.

Cevap: oluşan sipariş (2.5'teki biçimde).

### 2.5 Müşterinin siparişleri ve durumları
"Halılarım ne zaman gelir?" sorusunu cevaplamak için.

`GET /orders?customer_id=123`

```json
[
  {
    "id": "S1001",
    "customer_id": "123",
    "status": "yikamada",
    "pickup_date": "2026-11-12",
    "pickup_window": "10:00-12:00",
    "driver_name": "Mehmet",
    "items": [{ "type": "makine", "quantity": 2, "area_m2": 6 }],
    "estimated_total": 1070,
    "note": "",
    "created_at": "2026-11-10T09:05:00+03:00"
  }
]
```
`status` değerleri: `alinacak`, `alindi`, `yikamada`, `hazir`, `teslimatta`, `teslim_edildi`, `iptal`. Sizdeki durum adlarını listelemeniz yeterli, biz eşleştiririz. Teslimat tarihi biliniyorsa eklenmesi çok iyi olur.

### 2.6 Henüz alınmamış siparişi iptal etme

`POST /orders/{id}/cancel`

```json
{ "reason": "Müşteri iptal etti" }
```

## 3. Olursa iyi olur (zorunlu değil)

| Özellik | Neden |
|---|---|
| `GET /price-list` | Panelde fiyat değişince asistan da güncel fiyatı söylesin |
| Halı türü listesi (kodları ile) | Siparişteki `type` alanının sizdeki karşılıkları |
| Webhook: sipariş durumu değişince bize bildirim | "Halılarınız hazır" gibi otomatik bilgilendirme aramaları için |
| Teslimat randevusu oluşturma | Asistanın teslimat saatini de ayarlayabilmesi için |

## 4. Gizlilik ve güvenlik
- Müşteri verileri KVKK kapsamındadır. Gerekiyorsa veri işleme sözleşmesi imzalayabiliriz.
- Asistan sadece arayan kişinin kendi kaydına ve siparişlerine erişir. Toplu müşteri listesi çekmeyiz.
- API anahtarı sadece sunucumuzda saklanır. İsterseniz sunucumuzun sabit IP adresini de bildirebiliriz.

## 5. API yoksa
Kısa vadede API mümkün değilse, bizim yazılımımızın kendi kullanıcı hesabımızla Halıpratik paneline otomatik giriş yapıp aynı işlemleri ekrandan yapmasına izin verir misiniz? Bu durumda panelde düzen değişikliği olacağı zaman önceden haber almak isteriz.
