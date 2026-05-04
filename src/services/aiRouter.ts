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
  const summary = rawItem.rawText.trim().slice(0, 280) || rawItem.title;

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
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'You classify logistics intelligence items for a review queue.',
              'Return strict JSON with keys: title, summary, impactSummary, category, confidence, facts.',
              'Translate incoming user content to Turkish and ensure title, summary, and impactSummary are in Turkish.',
              `category must be one of: ${contentCategoryValues.join(', ')}`,
              'confidence must be a number between 0 and 1.',
              'Never claim the item is verified; simply normalize it for editor review.',
            ].join(' '),
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
      summary: parsed.summary?.trim() || rawItem.rawText.trim().slice(0, 280) || rawItem.title,
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