# kargomarket-intelligence-agent

Railway'de calisacak ilk ayri servis iskeleti.

Bu servis su an icin asagidaki gorevleri ustlenir:

- kaynak kayitlarini tutar
- ham metni review queue'ya donusturen ingest API'si sunar
- deterministik parser ile ilk kategori / confidence uretir
- model anahtarlari eklendiginde OpenAI-uyumlu servisler uzerinden ozetleme / siniflandirma yapabilir
- Telegram kullanici hesabi (MTProto) ile okunmus kanal icerigini ingest akisina tasiyabilir
- Telegram session string bilgisini Supabase `app_config` uzerinde kalici tutabilir
- Telegram kanal listesini Supabase `telegram_sources` tablosundan yukleyebilir
- raw ingest, parse ve review queue kayitlarini Supabase tablolarina yazabilir
- backoffice uygulamasi icin review queue endpoint sozlesmesini sabitler

Bu servis bilerek sinirli tutulmustur:

- tek veri gercegi prensibi vardir
- publish, veri kopyalama degil durum gecisidir
- AI tek basina hukuki veya yuksek etkili icerik yayinlamaz
- destructive admin aksiyonlari bu servisin ilk fazinda yoktur

## Faz 1 kapsami

- manual ingest endpoint
- manual veya scheduler tetikli tekli ingestion cycle endpoint'i
- Telegram user-session source config
- in-memory fallback repository
- source registry endpoint
- review queue listeleme ve durum guncelleme endpoint'i
- health ve dependency health endpoint'leri

## Mevcut calisma modeli

- servis Railway uzerinde calisir; kullanicinin PC'sinin acik olmasi gerekmez
- Telegram session bilgisi deploy sonrasi Supabase `app_config(key='telegram_session_string')` uzerinden geri yuklenir
- Telegram kanal listesi varsa Supabase `telegram_sources` tablosindan yuklenir; yoksa env fallback'i kullanilir
- raw ingest / parse / review queue tablolari varsa review verisi deploy sonrasi da korunur
- servis su an agirlikli olarak istek geldikce calisan bir HTTP API'dir
- repo icinde artik tek seferlik scheduler komutu vardir: `npm run ingest:once`
- periyodik calisma icin Railway scheduler/cron baglantisi hala deploy tarafinda tanimlanmalidir

## Telegram notu

Kanal okuma mantigi Bot API degil, kullanici hesabi + MTProto olarak modellenmistir. Bu nedenle `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, telefon dogrulama ve session string akisi beklenir.

GramJS istemcisi bu repoda servis katmanina eklenmistir. Telegram route'lari `AGENT_API_TOKEN` tanimliysa yetki basligi olmadan 401 doner.

Session persistence akisi artik lokal `.env` dosyasina yazma mantigina bagli degildir. Basarili OTP / 2FA sonrasi session string Supabase `app_config` tablosuna upsert edilir ve servis acilisinda oradan yuklenir.

Telegram kanal konfigrasyonu icin hedef veri gercegi `telegram_sources` tablosudur. `POST /v1/telegram/configure` icinde `sourceChannels` verilirse servis bu listeyi tabloya senkronlamaya calisir; tablo bos veya erisilemez durumdaysa env fallback'i korunur.

## Mimari yol haritasi

Siralama su sekilde tutulmalidir:

1. Supabase tablolarini tamamla.
2. Agent icine tek bir `run ingestion cycle` orchestrator isi ekle.
3. Railway scheduler veya esdegeri ile bu isi zamanli tetikle.
4. Hosted admin / backoffice ekranini ekle.

Bu siralamada lokal admin dashboard ilk oncelik degildir. Once veri kaynaklari, kanal listesi, job durumu ve kalici is akisinin Supabase tarafinda modellenmesi gerekir.

Hedef durum:

- kanal listesi env yerine Supabase tablosundan okunur
- agent otomatik ingestion cycle'i Railway uzerinde kullanicidan bagimsiz calistirir
- admin panel operasyon, reauth, kanal yonetimi ve job izlemesi icin kullanilir
- OTP yeniden girilmesi gerekirse bu islem hosted admin panelden tetiklenir

## Supabase tablolari

- `app_config`: Telegram session string gibi kucuk servis konfigrasyonlari
- `telegram_sources`: izlenecek kanal referanslari, enable durumu ve oncelik sirasi
- `raw_content_ingest`: ham icerik omurgasi
- `content_parse_results`: normalize / parse sonuclari
- `content_review_queue`: editor inceleme kuyrugu
- `agent_ingestion_runs`: scheduler / manual ingestion calismalarinin durum kaydi
- `telegram_channel_cursors`: kanal bazli son islenen mesaj referansi

## Gelistirme

```bash
npm install
npm run dev
```

Varsayilan port: `3001`

## Endpointler

- `GET /health`
- `GET /health/dependencies`
- `GET /v1/sources`
- `GET /v1/review-queue`
- `POST /v1/ingest/manual`
- `POST /v1/ingestion/run`
- `POST /v1/review-queue/:id/status`
- `GET /v1/telegram/status`
- `GET /v1/telegram/session`
- `POST /v1/telegram/configure`
- `POST /v1/telegram/send-code`
- `POST /v1/telegram/verify-code`
- `POST /v1/telegram/verify-2fa`
- `POST /v1/telegram/persist-session`
- `GET /v1/telegram/channels`
- `POST /v1/telegram/read-messages`
- `POST /v1/telegram/search`

## Railway scheduler

Repo artik Railway cron icin dogrudan calistirilabilir tek seferlik ingestion komutu icerir:

```bash
npm run build
npm run ingest:once
```

Opsiyonel env ayarlari:

- `INGESTION_CHANNEL_REFS`: virgulle ayrilmis kanal listesi; bos birakilirsa `telegram_sources` veya env fallback kullanilir
- `INGESTION_LIMIT_PER_CHANNEL`: kanal basina okunacak mesaj limiti
- `INGESTION_TRIGGER_SOURCE`: run kaydinda gorunecek kaynak etiketi; varsayilan `railway-scheduler`

Bu komut `partial` veya `failed` durumda non-zero exit code ile cikar. Bu sayede Railway cron hata gozlemi yapabilir.

Railway tarafinda iki pratik kullanim sekli vardir:

- ayni env'leri tasiyan ayri bir cron/worker komutunda `npm run ingest:once`
- harici scheduler kullaniliyorsa token korumali `POST /v1/ingestion/run` cagrisini tetiklemek

HTTP tetikleme ornegi:

```bash
curl -X POST "$APP_URL/v1/ingestion/run" \
	-H "Authorization: Bearer $AGENT_API_TOKEN" \
	-H "Content-Type: application/json" \
	-d '{"triggerSource":"railway-scheduler","limitPerChannel":20}'
```

## Telegram quick flow

- `configure`: `apiId` + `apiHash` (+ opsiyonel `sessionString`)
- `send-code`: telefon numarasina kod gonder
- `verify-code`: kodu dogrula
- `verify-2fa`: 2FA aciksa sifreyi dogrula
- `session`: aktif session bilgisini goster
- `persist-session`: aktif session bilgisini Supabase `app_config` icine yaz
- `channels` / `read-messages` / `search`: kanal verilerini listele/oku/ara
- `ingestion/run`: tracked Telegram kanallarindan yeni mesajlari okuyup review queue'ya sok

## Hedef entegrasyon

- public uygulama: sadece `published` katmani okur
- intelligence agent: `raw` ve `review` katmanini doldurur
- backoffice: `review` akisini yonetir ve `publish` kararini verir
- gelecekte scheduler / worker katmani agent'i kullanicidan bagimsiz tam otomasyona tasir
