# kargomarket-intelligence-agent

Railway'de calisacak ilk ayri servis iskeleti.

Bu servis su an icin asagidaki gorevleri ustlenir:

- kaynak kayitlarini tutar
- ham metni review queue'ya donusturen ingest API'si sunar
- deterministik parser ile ilk kategori / confidence uretir
- model anahtarlari eklendiginde OpenAI-uyumlu servisler uzerinden ozetleme / siniflandirma yapabilir
- Telegram kullanici hesabi (MTProto) ile okunmus kanal icerigini ingest akisina tasiyabilir
- backoffice uygulamasi icin review queue endpoint sozlesmesini sabitler

Bu servis bilerek sinirli tutulmustur:

- tek veri gercegi prensibi vardir
- publish, veri kopyalama degil durum gecisidir
- AI tek basina hukuki veya yuksek etkili icerik yayinlamaz
- destructive admin aksiyonlari bu servisin ilk fazinda yoktur

## Faz 1 kapsami

- manual ingest endpoint
- Telegram user-session source config
- in-memory repository
- source registry endpoint
- review queue listeleme ve durum guncelleme endpoint'i
- health ve dependency health endpoint'leri

## Telegram notu

Kanal okuma mantigi Bot API degil, kullanici hesabi + MTProto olarak modellenmistir. Bu nedenle `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, telefon dogrulama ve session string akisi beklenir.

GramJS istemcisi bu repoda servis katmanina eklenmistir. Telegram route'lari `AGENT_API_TOKEN` tanimliysa yetki basligi olmadan 401 doner.

## Sonraki adim

`kargomarket-backoffice` bu servisin review queue endpoint'lerini tuketerek preview / approve / reject / publish akislarini yonetecek.

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
- `POST /v1/review-queue/:id/status`
- `GET /v1/telegram/status`
- `POST /v1/telegram/configure`
- `POST /v1/telegram/send-code`
- `POST /v1/telegram/verify-code`
- `POST /v1/telegram/verify-2fa`
- `GET /v1/telegram/channels`
- `POST /v1/telegram/read-messages`
- `POST /v1/telegram/search`

## Telegram quick flow

- `configure`: `apiId` + `apiHash` (+ opsiyonel `sessionString`)
- `send-code`: telefon numarasina kod gonder
- `verify-code`: kodu dogrula
- `verify-2fa`: 2FA aciksa sifreyi dogrula
- `channels` / `read-messages` / `search`: kanal verilerini listele/oku/ara

## Hedef entegrasyon

- public uygulama: sadece `published` katmani okur
- intelligence agent: `raw` ve `review` katmanini doldurur
- backoffice: `review` akisini yonetir ve `publish` kararini verir
