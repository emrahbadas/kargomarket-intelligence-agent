import { createHash, randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import type { DependencyHealth, ManualIngestInput, ParsedSignal, PublishTarget, RawIngestItem, ReviewQueueItem, ReviewStatus, SourceRecord } from '../domain/types.js';
import { InMemoryStore } from './inMemoryStore.js';
import { ModelRouter } from './aiRouter.js';
import { getSourceCatalog } from './sourceCatalog.js';

const resolvePublishTarget = (category: ParsedSignal['category']): PublishTarget => {
  if (category === 'fuel' || category === 'route' || category === 'supply-demand') {
    return 'market-signal';
  }

  return 'sector-news';
};

export class PipelineService {
  constructor(
    private readonly store = new InMemoryStore(),
    private readonly modelRouter = new ModelRouter(),
    private readonly sources: SourceRecord[] = getSourceCatalog(),
  ) {}

  listSources() {
    return this.sources;
  }

  listReviewQueue() {
    return this.store.listReviews();
  }

  getDependencyHealth(): DependencyHealth {
    return {
      models: this.modelRouter.getHealth(),
      supabase: env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? 'configured' : 'not_configured',
      redis: env.ENABLE_REDIS && env.REDIS_URL ? 'configured' : 'disabled',
      telegramUser:
        env.ENABLE_TELEGRAM_USER_SOURCE &&
        !!env.TELEGRAM_API_ID &&
        !!env.TELEGRAM_API_HASH &&
        (!!env.TELEGRAM_SESSION_STRING || !!env.TELEGRAM_PHONE_NUMBER)
          ? 'configured'
          : 'disabled',
      youtube: env.ENABLE_YOUTUBE_METADATA && env.YOUTUBE_API_KEY ? 'configured' : 'disabled',
    };
  }

  getStats() {
    return this.store.stats();
  }

  async submitManualIngest(input: ManualIngestInput) {
    const sourceId = `manual-${input.sourceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const checksum = createHash('sha256')
      .update(`${input.sourceName}\n${input.title}\n${input.rawText}`)
      .digest('hex');
    const now = new Date().toISOString();

    const rawItem: RawIngestItem = {
      id: randomUUID(),
      sourceId,
      sourceName: input.sourceName,
      title: input.title.trim(),
      rawText: input.rawText.trim(),
      sourceUrl: input.sourceUrl,
      publishedAt: now,
      checksum,
      createdAt: now,
    };

    this.store.saveRaw(rawItem);

    const normalized = await this.modelRouter.summarize(rawItem);

    const parsedItem: ParsedSignal = {
      id: randomUUID(),
      rawIngestId: rawItem.id,
      category: normalized.category,
      title: normalized.title,
      summary: normalized.summary,
      impactSummary: normalized.impactSummary,
      confidence: normalized.confidence,
      facts: normalized.facts,
      createdAt: now,
    };

    this.store.saveParsed(parsedItem);

    const reviewItem: ReviewQueueItem = {
      id: randomUUID(),
      parsedSignalId: parsedItem.id,
      rawIngestId: rawItem.id,
      status: 'pending',
      publishTarget: resolvePublishTarget(parsedItem.category),
      title: parsedItem.title,
      summary: parsedItem.summary,
      impactSummary: parsedItem.impactSummary,
      category: parsedItem.category,
      confidence: parsedItem.confidence,
      sourceName: rawItem.sourceName,
      sourceUrl: rawItem.sourceUrl,
      createdAt: now,
      updatedAt: now,
    };

    this.store.saveReview(reviewItem);

    return {
      rawItem,
      parsedItem,
      reviewItem,
    };
  }

  updateReviewStatus(id: string, status: ReviewStatus, reviewerNotes?: string) {
    return this.store.updateReviewStatus(id, status, reviewerNotes);
  }
}