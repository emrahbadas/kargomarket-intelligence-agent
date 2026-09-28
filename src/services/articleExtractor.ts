import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

/**
 * Haber sayfasinin TAM METNINI cikarir.
 *
 * NEDEN GEREKLI
 * Onceki surumde havuza yalnizca arama modelinin kendi yazdigi ozet
 * giriyordu. Yani ozetin ozeti uzerinden calisiliyordu: elde az malzeme
 * olunca model bosluklari kendi bilgisiyle dolduruyor ve UYDURMA RISKI
 * artiyordu. Gercek metni okuyunca model uretmez, aktarir.
 *
 * NEDEN OKUNABILIRLIK ALGORITMASI, REGEX DEGIL
 * Haber siteleri govdeyi tek parca vermez: birkac cumle giris, sonra
 * reklam veya gorsel, sonra metnin geri kalani. Bunlar ayri DOM
 * dugumleridir. Readability her dugumun metin yogunlugunu puanlar ve
 * yuksek puanli kardes dugumleri birlestirir - parcalanmis govdeyi
 * bu yuzden dogru toplar. Regex ile ilk <p> bloguna bakmak, tam da
 * kullanicinin tarif ettigi "reklamdan sonrasini kacirma" hatasina duser.
 */

const FETCH_TIMEOUT_MS = 20_000;
/** 5 MB'tan buyuk sayfa haber degildir; indirmeyi kes. */
const MAX_BYTES = 5 * 1024 * 1024;
/** Bundan kisa cikti basarisiz sayilir; muhtemelen cerez duvari ya da bot engeli. */
const MIN_ARTICLE_CHARS = 400;

/**
 * Gercek bir tarayici gibi tanit. Bircok haber sitesi bilinmeyen
 * istemciyi reddeder; kimligi gizlemek degil, engellenmemek icin.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export interface ExtractedArticle {
  url: string;
  title: string | null;
  text: string;
  charCount: number;
  byline: string | null;
  publishedTime: string | null;
  /** Cikarim basarisiz olduysa sebebi; basariliysa null. */
  failureReason: string | null;
}

/**
 * Govdeye karisan arayuz metinlerini temizler.
 * Readability yapiyi dogru toplar ama "REKLAM", "Ilgili Haberler",
 * "Paylas" gibi etiketleri de beraberinde getirebilir; bunlar ozete
 * gurultu olarak girer.
 */
const NOISE_PATTERNS: RegExp[] = [
  /^(reklam|advertisement|sponsorlu icerik|sponsored)$/i,
  /^(ilgili haberler?|iliskili haberler?|related (articles?|news)|bunlar da ilginizi cekebilir)$/i,
  /^(paylas|share|tweetle|whatsapp'ta paylas)$/i,
  /^(abone ol|subscribe|bultene kaydol|haber bultenimize)$/i,
  /^(yorum yaz|yorumlar|comments?)$/i,
  /^(kaynak|source)\s*:?\s*$/i,
  /^(devami icin tiklayin|devamini oku|read more)$/i,
  /cerez(ler)?i? (kullan|kabul|politika)/i,
  /^(foto(graf)?|video|galeri)\s*:?\s*$/i,
];

const cleanArticleText = (raw: string): string => {
  return raw
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => {
      if (!line) return false;
      if (NOISE_PATTERNS.some((pattern) => pattern.test(line))) return false;
      // Tek kelimelik bagimsiz satirlar neredeyse her zaman arayuz etiketidir.
      if (line.length < 25 && !/[.!?:]$/.test(line) && line.split(' ').length <= 3) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

/** Yanit govdesini boyut sinirina uyarak metne cevirir. */
const readBounded = async (response: Response): Promise<string> => {
  const uzunluk = Number(response.headers.get('content-length') || 0);
  if (uzunluk && uzunluk > MAX_BYTES) {
    throw new Error(`Sayfa cok buyuk (${Math.round(uzunluk / 1024)} KB)`);
  }
  return await response.text();
};

export const extractArticle = async (url: string): Promise<ExtractedArticle> => {
  const bos = (reason: string): ExtractedArticle => ({
    url,
    title: null,
    text: '',
    charCount: 0,
    byline: null,
    publishedTime: null,
    failureReason: reason,
  });

  let html: string;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return bos(`HTTP ${response.status}`);
    }

    const tip = response.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(tip)) {
      return bos(`Beklenmeyen icerik turu: ${tip.split(';')[0] || 'bilinmiyor'}`);
    }

    html = await readBounded(response);
  } catch (error) {
    const mesaj = error instanceof Error ? error.message : String(error);
    return bos(/timeout|abort/i.test(mesaj) ? 'Zaman asimi' : mesaj);
  }

  try {
    const { document } = parseHTML(html);
    const makale = new Readability(document as unknown as Document).parse();

    if (!makale?.textContent) {
      return bos('Sayfadan makale govdesi cikarilamadi');
    }

    const text = cleanArticleText(makale.textContent);

    if (text.length < MIN_ARTICLE_CHARS) {
      // Cogunlukla cerez duvari, abonelik duvari ya da bot engeli demektir.
      return bos(`Cikarilan metin cok kisa (${text.length} karakter)`);
    }

    return {
      url,
      title: makale.title?.trim() || null,
      text,
      charCount: text.length,
      byline: makale.byline?.trim() || null,
      publishedTime: makale.publishedTime?.trim() || null,
      failureReason: null,
    };
  } catch (error) {
    return bos(`Ayristirma hatasi: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * Birden fazla adresi sinirli es zamanlilikla cikarir.
 *
 * Es zamanlilik bilincli olarak dusuk: ayni anda onlarca istek atmak
 * haber sitelerinde hiz sinirina ve IP engeline yol acar. Bu bir
 * tarama araci degil, atif verdigimiz sayfalari okuyan bir okuyucudur.
 */
export const extractArticles = async (
  urls: string[],
  concurrency = 3,
): Promise<Map<string, ExtractedArticle>> => {
  const sonuc = new Map<string, ExtractedArticle>();
  const kuyruk = [...new Set(urls)];

  const isci = async () => {
    for (;;) {
      const url = kuyruk.shift();
      if (!url) return;
      sonuc.set(url, await extractArticle(url));
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, kuyruk.length) }, () => isci()),
  );

  return sonuc;
};
