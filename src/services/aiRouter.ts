import type { AppEnv } from '../config/env.js';
import { env } from '../config/env.js';
import { contentCategoryValues, type ContentCategory, type ParsedSignal, type RawIngestItem } from '../domain/types.js';

type ParsedDraft = Pick<ParsedSignal, 'category' | 'title' | 'summary' | 'impactSummary' | 'confidence' | 'facts'>;

const providerPath = (baseUrl: string) => `${baseUrl.replace(/\/$/, '')}/chat/completions`;

const sanitizeCategory = (value: string): ContentCategory => {
  return contentCategoryValues.includes(value as ContentCategory) ? (value as ContentCategory) : 'other';
};

const extractJson = (content: string) => {
  const fenced = content.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const braceStart = content.indexOf('{');
  const braceEnd = content.lastIndexOf('}');

  if (braceStart >= 0 && braceEnd > braceStart) {
    return content.slice(braceStart, braceEnd + 1);
  }

  return content;
};

const fallbackParse = (rawItem: RawIngestItem): ParsedDraft => {
  const text = `${rawItem.title}\n${rawItem.rawText}`.toLowerCase();
  const rules: Array<{ category: ContentCategory; keywords: string[]; impact: string }> = [
    { category: 'fuel', keywords: ['mazot', 'akaryakit', 'motorin', 'petrol', 'benzin'], impact: 'Yakit maliyetleri uzerinden kara tasimasi fiyatlarini etkileyebilir.' },
    { category: 'customs', keywords: ['gumruk', 'hs kodu', 'vergi', 'ithalat', 'ihracat'], impact: 'Mevzuat veya vergi maliyetleri uzerinden ticaret akisini etkileyebilir.' },
    { category: 'weather', keywords: ['sel', 'firtina', 'yagis', 'afet', 'don'], impact: 'Operasyon, rota ve tedarik surekliliginde gecikme riski uretebilir.' },
    { category: 'route', keywords: ['kopru', 'otoyol', 'sinir kapisi', 'liman', 'rota', 'gecis'], impact: 'Rota maliyeti veya transit sureleri uzerinde dogrudan etkili olabilir.' },
    { category: 'regulation', keywords: ['resmi gazete', 'yonetmelik', 'duzenleme', 'teblig'], impact: 'Uyum, belge ve operasyon kurallarini degistirebilir.' },
    { category: 'supply-demand', keywords: ['arz', 'talep', 'zayii', 'rekolte', 'stok', 'kapasite'], impact: 'Yuk talebi veya kapasite dengesinde degisim uretebilir.' },
  ];

  const matchedRule = rules.find((rule) => rule.keywords.some((keyword) => text.includes(keyword)));
  const category = matchedRule?.category ?? 'other';
  // Model devre disiyken kullanilan yedek yol. 280 karakterlik eski sinir
  // uzun ham metinleri de kirpiyordu; editor kuyruguna giden veri ne kadar
  // tamsa editorun isi o kadar kolay olur.
  const summary = rawItem.rawText.trim().slice(0, 1500) || rawItem.title;

  return {
    category,
    title: rawItem.title,
    summary,
    impactSummary: matchedRule?.impact ?? 'Editoryal degerlendirme gerektirir.',
    confidence: matchedRule ? 0.62 : 0.35,
    facts: {
      source_name: rawItem.sourceName,
      source_url: rawItem.sourceUrl ?? null,
      published_at: rawItem.publishedAt,
    },
  };
};

export class ModelRouter {
  constructor(private readonly appEnv: AppEnv = env) {}

  getHealth() {
    if (this.appEnv.DEFAULT_MODEL_PROVIDER === 'disabled') {
      return 'disabled' as const;
    }

    if (this.appEnv.DEFAULT_MODEL_PROVIDER === 'openai') {
      return this.appEnv.OPENAI_API_KEY ? ('ready' as const) : ('missing_key' as const);
    }

    return this.appEnv.PERPLEXITY_API_KEY ? ('ready' as const) : ('missing_key' as const);
  }

  async summarize(rawItem: RawIngestItem): Promise<ParsedDraft> {
    if (this.getHealth() !== 'ready') {
      return fallbackParse(rawItem);
    }

    try {
      return await this.runModel(rawItem);
    } catch {
      return fallbackParse(rawItem);
    }
  }

  private async runModel(rawItem: RawIngestItem): Promise<ParsedDraft> {
    const provider = this.appEnv.DEFAULT_MODEL_PROVIDER;
    const apiKey = provider === 'openai' ? this.appEnv.OPENAI_API_KEY : this.appEnv.PERPLEXITY_API_KEY;
    const baseUrl = provider === 'openai' ? this.appEnv.OPENAI_BASE_URL : this.appEnv.PERPLEXITY_BASE_URL;
    const model = provider === 'openai' ? this.appEnv.OPENAI_MODEL : this.appEnv.PERPLEXITY_MODEL;

    const response = await fetch(providerPath(baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        // Onceki surumde max_tokens yoktu ve istem uzunluk hic belirtmiyordu;
        // model 150-280 karakterlik ozetlerle yetiniyordu. 1500 token, hedef
        // 800-1200 karakterlik ozet + etki degerlendirmesi icin rahat sinir.
        max_tokens: 1500,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'Sen bir lojistik istihbarat editorusun. Gelen ham icerigi editor kuyruguna hazirliyorsun.',
              '',
              'Yalnizca su anahtarlarla gecerli JSON dondur: title, summary, impactSummary, category, confidence, facts.',
              '',
              'DIL: title, summary ve impactSummary TURKCE olmali. Gelen icerik baska dildeyse cevir.',
              '',
              'UZUNLUK - bu kritik:',
              '- summary 800-1200 karakter olmali. Bu bir tweet degil, kisa bir haber metnidir.',
              '- Tek cumlelik ozet KABUL EDILMEZ. En az 4-6 cumle yaz.',
              '- impactSummary 200-400 karakter olmali.',
              '',
              'SUMMARY NASIL YAZILIR:',
              '- Once ne oldugunu anlat: olay, aktorler, yer, zaman.',
              '- Sonra sayisal ayrintilari ver: fiyat, oran, tonaj, tarih, mesafe, sure. Kaynakta gecen her rakami kullan.',
              '- Kaynakta kim ne soylemis, gorusleri ayirt edilebilir sekilde aktar.',
              '- Belirsizlikleri acikca yaz ("kaynakta net sayi verilmiyor" gibi).',
              '',
              'UYDURMA YASAK: Kaynakta olmayan rakam, tarih, isim veya alinti URETME.',
              'Kaynak yetersizse summary kisa kalabilir; bosluklari uydurarak doldurmak yerine',
              'neyin eksik oldugunu yaz. Uzunluk hedefi, icerik varsa gecerlidir.',
              '',
              'impactSummary: bu gelismenin Turkiye lojistik sektorune somut etkisi.',
              'Hangi tasima modu, hangi rota, hangi maliyet kalemi, hangi tarafi etkiler?',
              '',
              `category su degerlerden biri olmali: ${contentCategoryValues.join(', ')}`,
              'confidence 0 ile 1 arasinda bir sayi olmali; kaynak zayifsa dusuk ver.',
              '',
              'facts: kaynaktan cikardigin yapisal veriler (sayilar, tarihler, yer adlari,',
              'kurum isimleri). Anahtarlari snake_case yaz.',
              '',
              'Icerigin dogrulandigini ASLA iddia etme; bunu editor incelemesi icin normallestiriyorsun.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({
              title: rawItem.title,
              rawText: rawItem.rawText,
              sourceName: rawItem.sourceName,
              sourceUrl: rawItem.sourceUrl,
              publishedAt: rawItem.publishedAt,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(this.appEnv.MODEL_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Model provider returned ${response.status}`);
    }

    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content;

    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Model provider returned empty content');
    }

    const parsed = JSON.parse(extractJson(content)) as {
      title?: string;
      summary?: string;
      impactSummary?: string;
      category?: string;
      confidence?: number;
      facts?: Record<string, string | number | boolean | null>;
    };

    return {
      title: parsed.title?.trim() || rawItem.title,
      summary: parsed.summary?.trim() || rawItem.rawText.trim().slice(0, 1500) || rawItem.title,
      impactSummary: parsed.impactSummary?.trim() || 'Editoryal degerlendirme gerekir.',
      category: sanitizeCategory(parsed.category ?? 'other'),
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      facts: parsed.facts ?? {
        source_name: rawItem.sourceName,
        source_url: rawItem.sourceUrl ?? null,
      },
    };
  }
}