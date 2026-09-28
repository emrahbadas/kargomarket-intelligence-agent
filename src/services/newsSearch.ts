import { env, type AppEnv } from '../config/env.js';
import { extractArticles, type ExtractedArticle } from './articleExtractor.js';
import { truncateAtSentence } from './textBudget.js';

/**
 * Acik haber kaynaklarindan lojistik haberi toplar.
 *
 * NEDEN PERPLEXITY SONAR
 * Sonar web'de arama yapar ve kullandigi kaynaklarin listesini yanitla
 * birlikte dondurur. RSS listesi derleyip bakimini yapmaya gerek kalmaz ve
 * kaynak atfi modelin iyi niyetine degil, API'nin kendi ciktisina dayanir.
 *
 * URL UYDURMA KORUMASI - bu modulun en onemli parcasi
 * Dil modelleri gercek gorunumlu ama var olmayan URL uretir. Modelin
 * metinde yazdigi adrese GUVENILMEZ. Bu yuzden her haberin kaynak adresi,
 * API'nin `citations` / `search_results` alaninda gercekten dondurdugu
 * adreslerle karsilastirilir; listede olmayan adres atilir ve haber
 * kaynaksiz kabul edilir.
 *
 * Kaynaksiz haber editor kuyruguna DUSMEZ: atfi dogrulanamayan icerigi
 * yayinlamak, platformun guvenilirligini kaybetmesinin en hizli yoludur.
 */

const SONAR_TIMEOUT_MS = 45_000;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
/**
 * Tek bir makaleden havuza girecek en fazla karakter.
 *
 * Onceki surumde havuza yalnizca arama modelinin ~1000 karakterlik ozeti
 * giriyordu. 6000 karakter, uzun analiz yazilarinin buyuk kismini alir ve
 * modelin UYDURMADAN yazabilmesi icin gereken malzemeyi fazlasiyla verir.
 * Kirpma cumle sinirinda yapilir.
 */
const MAX_ARTICLE_CHARS = 6000;

export interface NewsSearchInput {
  /** Aranacak konu basliklari. Bos birakilirsa varsayilan lojistik gundemi kullanilir. */
  keywords?: string[];
  limit?: number;
  /** Kac saat geriye bakilacagi. Varsayilan 48 saat. */
  recencyHours?: number;
}

export interface NewsCitation {
  url: string;
  title: string | null;
  publishedAt: string | null;
}

export interface NewsSearchItem {
  title: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  publishedAt: string | null;
  /** Bu habere dayanak olan, API tarafindan dogrulanmis adresler. */
  citations: NewsCitation[];
  /** Pipeline'a verilecek ham metin. */
  rawText: string;
  /**
   * Kaynak sayfadan gercek makale metni cekilebildi mi.
   * false ise havuzda yalnizca arama modelinin ozeti var - bu durumda
   * ozetleyici modelin elinde daha az malzeme olur.
   */
  articleFetched: boolean;
  /** Cekilen makale metninin karakter sayisi. */
  articleCharCount: number;
  /** Cekilemediyse sebebi (bot engeli, cerez duvari, zaman asimi...). */
  articleFailureReason: string | null;
  /**
   * Cekilen makaleden onizleme kesiti.
   *
   * NEDEN VAR: editor tezgahta `summary` alanini goruyordu, o ise arama
   * modelinin kendi ozeti - yani havuza giren asil malzeme DEGIL. Zengin
   * bir makale cekilmis olsa bile kart yalin gorunuyor ve "icerik az
   * geliyor" izlenimi veriyordu. Bu alan gercekte ne toplandigini gosterir.
   */
  articleExcerpt: string | null;
}

export interface NewsSearchResult {
  query: string;
  items: NewsSearchItem[];
  /** API'nin dondurdugu tum kaynaklar (haberlere eslenemeyenler dahil). */
  allCitations: NewsCitation[];
  /** Modelin verdigi ama atif listesinde bulunmayan, bu yuzden atilan adresler. */
  rejectedUrls: string[];
  model: string;
  /** Kac haberin tam metni cekilebildi. */
  articlesFetched: number;
  /** Cekilen tum makalelerin toplam karakteri - havuzun gercek buyuklugu. */
  totalArticleChars: number;
}

const DEFAULT_KEYWORDS = [
  'Turkiye lojistik sektoru',
  'navlun fiyatlari',
  'liman ve gumruk duzenlemeleri',
  'karayolu tasimaciligi mevzuat',
  'konteyner ve denizyolu tasimaciligi',
];

const normalizeUrl = (value: unknown): string | null => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Karsilastirma icin sadelestir: son egik cizgi ve izleme parametreleri
    // ayni kaynagi farkli gostermesin.
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'bilinmeyen kaynak';
  }
};

const extractJson = (content: string) => {
  const fenced = content.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  return start >= 0 && end > start ? content.slice(start, end + 1) : content;
};

/**
 * API yanitindan dogrulanmis kaynak listesini cikarir.
 * Perplexity surumden surume `citations` (duz URL dizisi) ya da
 * `search_results` (baslik + tarih iceren nesneler) dondurebiliyor;
 * ikisi de destekleniyor.
 */
const collectCitations = (payload: Record<string, unknown>): NewsCitation[] => {
  const cikti = new Map<string, NewsCitation>();

  const searchResults = payload.search_results;
  if (Array.isArray(searchResults)) {
    for (const row of searchResults) {
      const item = row as Record<string, unknown>;
      const url = normalizeUrl(item.url);
      if (!url) continue;
      cikti.set(url, {
        url,
        title: item.title ? String(item.title) : null,
        publishedAt: item.date ? String(item.date) : null,
      });
    }
  }

  const citations = payload.citations;
  if (Array.isArray(citations)) {
    for (const row of citations) {
      const url = normalizeUrl(typeof row === 'string' ? row : (row as Record<string, unknown>)?.url);
      if (!url || cikti.has(url)) continue;
      cikti.set(url, { url, title: null, publishedAt: null });
    }
  }

  return [...cikti.values()];
};

export class NewsSearchService {
  constructor(private readonly appEnv: AppEnv = env) {}

  isConfigured(): boolean {
    return Boolean(this.appEnv.PERPLEXITY_API_KEY);
  }

  async search(input: NewsSearchInput = {}): Promise<NewsSearchResult> {
    if (!this.isConfigured()) {
      throw new Error('PERPLEXITY_API_KEY tanimli degil; haber taramasi yapilamaz.');
    }

    const keywords = (input.keywords?.length ? input.keywords : DEFAULT_KEYWORDS)
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    const limit = Math.max(1, Math.min(Number(input.limit) || DEFAULT_LIMIT, MAX_LIMIT));
    const recencyHours = Math.max(1, Math.min(Number(input.recencyHours) || 48, 24 * 14));
    const query = keywords.join(', ');
    const model = this.appEnv.PERPLEXITY_MODEL;

    const response = await fetch(
      `${this.appEnv.PERPLEXITY_BASE_URL.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.appEnv.PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 4000,
          // Sonar'in arama penceresi. Gun cinsinden kabul ediyor.
          search_recency_filter: recencyHours <= 24 ? 'day' : recencyHours <= 168 ? 'week' : 'month',
          messages: [
            {
              role: 'system',
              content: [
                'Sen bir lojistik sektoru haber editorusun. Web aramasi yaparak GUNCEL haberleri topluyorsun.',
                '',
                'Yalnizca su yapida gecerli JSON dondur:',
                '{"items":[{"title":"...","summary":"...","sourceUrl":"...","publishedAt":"YYYY-MM-DD"}]}',
                '',
                `En fazla ${limit} haber dondur.`,
                '',
                'HER HABER ICIN:',
                '- title: Turkce, 60-90 karakter, olayi acikca anlatan baslik.',
                '- summary: TURKCE, 800-1200 karakter. Tek cumle KABUL EDILMEZ.',
                '  Ne oldu, kim yapti, nerede, ne zaman - hepsini yaz.',
                '  Kaynakta gecen her sayiyi kullan: fiyat, oran, tonaj, tarih, sure.',
                '  Sonunda bu gelismenin Turkiye lojistigine etkisini bir-iki cumleyle belirt.',
                '- sourceUrl: haberin alindigi GERCEK adres. Tahmin etme, uydurma.',
                '- publishedAt: yayin tarihi, YYYY-MM-DD.',
                '',
                'UYDURMA YASAK: Kaynakta olmayan rakam, alinti veya olay yazma.',
                'Yeterli guncel haber bulamazsan az sayida haber dondur; sayiyi doldurmak icin',
                'eski haberleri guncelmis gibi sunma.',
              ].join('\n'),
            },
            {
              role: 'user',
              content: `Son ${recencyHours} saatteki su konularda haberleri bul: ${query}`,
            },
          ],
        }),
        signal: AbortSignal.timeout(SONAR_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Perplexity hatasi ${response.status}: ${text.slice(0, 220)}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const allCitations = collectCitations(payload);
    const izinliUrlSet = new Set(allCitations.map((item) => item.url));

    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    const content = (choices?.[0]?.message as Record<string, unknown> | undefined)?.content;

    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Perplexity bos yanit dondurdu.');
    }

    const parsed = JSON.parse(extractJson(content)) as {
      items?: Array<{ title?: string; summary?: string; sourceUrl?: string; publishedAt?: string }>;
    };

    const rejectedUrls: string[] = [];

    // Once atfi dogrulanan haberleri ayikla.
    const dogrulanan = (parsed.items ?? []).flatMap((row) => {
      const title = String(row.title || '').trim();
      const summary = String(row.summary || '').trim();
      if (!title || !summary) return [];

      const iddiaEdilen = normalizeUrl(row.sourceUrl);

      // ATIF DOGRULAMASI: modelin yazdigi adres, API'nin gercekten
      // kullandigi kaynaklar arasinda mi? Degilse uydurulmus kabul edilir.
      if (!iddiaEdilen || !izinliUrlSet.has(iddiaEdilen)) {
        if (row.sourceUrl) rejectedUrls.push(String(row.sourceUrl));
        return [];
      }

      const eslesen = allCitations.find((item) => item.url === iddiaEdilen)!;
      return [{
        title,
        summary,
        url: iddiaEdilen,
        citation: eslesen,
        publishedAt: row.publishedAt || eslesen.publishedAt || null,
      }];
    });

    // AYNI ADRESI BIR KEZ AL.
    // Birden fazla anahtar kelime verildiginde Sonar ayni makaleyi farkli
    // basliklarla birden cok kez dondurebiliyor (uretimde gozlendi: ayni
    // rayhaber.com yazisi iki ayri baslikla geldi). Tekilleştirmezsek
    // havuz sisik gorunur, editor ayni haberi iki kez degerlendirir ve
    // ayni sayfayi bosuna iki kez indiririz.
    const gorulen = new Set<string>();
    const benzersiz = dogrulanan.filter((item) => {
      if (gorulen.has(item.url)) return false;
      gorulen.add(item.url);
      return true;
    });

    // HAVUZUN ASIL DOLDUGU YER BURASI.
    // Arama modelinin ozeti havuz icin yeterli degildi: elde az malzeme
    // olunca ozetleyici model bosluklari kendi bilgisiyle doldurur ve
    // uydurma riski artar. Dogrulanan her adresin sayfasi indirilip tam
    // makale metni cikariliyor; modele giden sey artik ozetin ozeti degil,
    // haberin kendisi.
    const makaleler = await extractArticles(benzersiz.map((item) => item.url));

    const items: NewsSearchItem[] = benzersiz.map((item) => {
      const makale: ExtractedArticle | undefined = makaleler.get(item.url);
      const tamMetin = makale && !makale.failureReason ? makale.text : null;

      // Butce CUMLE SINIRINDA uygulanir; ortadan bolunen cumle hem
      // okunamaz hem de modele yarim baglam verir ve model onu kendi
      // tahminiyle tamamlar.
      const govde = tamMetin
        ? truncateAtSentence(tamMetin, { budget: MAX_ARTICLE_CHARS })
        : null;

      return {
        title: item.title,
        summary: item.summary,
        sourceName: hostOf(item.url),
        sourceUrl: item.url,
        publishedAt: item.publishedAt,
        citations: [item.citation],
        articleFetched: Boolean(govde),
        articleCharCount: govde?.length ?? 0,
        articleFailureReason: makale?.failureReason ?? 'Cikarim denenmedi',
        // Onizleme cumle sinirinda kesilir; kartta yarim cumle gostermek
        // editore metnin bozuk oldugu izlenimi verir.
        articleExcerpt: govde ? truncateAtSentence(govde, { budget: 700 }) : null,
        rawText: [
          'Acik haber kaynagi taramasi',
          `Aranan konular: ${query}`,
          `Haber basligi: ${item.title}`,
          `Kaynak: ${hostOf(item.url)}`,
          `Kaynak adresi: ${item.url}`,
          item.publishedAt ? `Yayin tarihi: ${item.publishedAt}` : null,
          makale?.byline ? `Yazar: ${makale.byline}` : null,
          '',
          govde
            ? '--- KAYNAK SAYFADAN CEKILEN TAM MAKALE METNI ---'
            : '--- ARAMA MODELI OZETI (tam metin cekilemedi) ---',
          govde || item.summary,
          '',
          govde
            ? `Not: Yukaridaki metin kaynak sayfadan dogrudan cekildi (${govde.length} karakter). Ozeti BU METINDEN cikar, disaridan bilgi ekleme.`
            : `Not: Kaynak sayfanin tam metni cekilemedi (${makale?.failureReason || 'bilinmeyen sebep'}). Elde yalnizca arama modelinin ozeti var; eksik ayrintilari TAHMIN ETME, ozet kisa kalabilir.`,
          "Kaynak adresi API'nin dondurdugu atif listesiyle dogrulandi.",
          'Dogrulugu editor tarafindan teyit edilmelidir.',
        ].filter((line): line is string => line !== null).join('\n'),
      };
    });

    const articlesFetched = items.filter((item) => item.articleFetched).length;
    const totalArticleChars = items.reduce((acc, item) => acc + item.articleCharCount, 0);

    return { query, items, allCitations, rejectedUrls, model, articlesFetched, totalArticleChars };
  }
}
