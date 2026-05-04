import { createHash, randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import type { DependencyHealth, ManualIngestInput, ParsedSignal, PublishTarget, PublishedContentItem, RawIngestItem, ReviewQueueItem, ReviewStatus, SourceRecord } from '../domain/types.js';
import { InMemoryStore } from './inMemoryStore.js';
import { ModelRouter } from './aiRouter.js';
import { getSourceCatalog } from './sourceCatalog.js';
import { SupabasePipelineStore } from './supabasePipelineStore.js';

const resolvePublishTarget = (category: ParsedSignal['category']): PublishTarget => {
  if (category === 'fuel' || category === 'route' || category === 'supply-demand') {
    return 'market-signal';
  }

  return 'sector-news';
};

export class PipelineService {
  constructor(
    private readonly store = new InMemoryStore(),
    private readonly supabaseStore = new SupabasePipelineStore(),
    private readonly modelRouter = new ModelRouter(),
    private readonly sources: SourceRecord[] = getSourceCatalog(),
  ) {}

  listSources() {
    return this.sources;
  }

  async listReviewQueue() {
    if (this.supabaseStore.isConfigured()) {
      return this.supabaseStore.listReviews();
    }

    return this.store.listReviews();
  }

  async listPublished(target?: PublishTarget, limit = 100) {
    if (this.supabaseStore.isConfigured()) {
      return this.supabaseStore.listPublished(target, limit);
    }

    return this.store.listPublished(target).slice(0, limit);
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

  async getStats() {
    if (this.supabaseStore.isConfigured()) {
      return this.supabaseStore.getStats();
    }

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
      sourceId: input.sourceId || sourceId,
      sourceName: input.sourceName,
      title: input.title.trim(),
      rawText: input.rawText.trim(),
      sourceUrl: input.sourceUrl,
      publishedAt: input.publishedAt || now,
      checksum,
      createdAt: now,
    };

    if (this.supabaseStore.isConfigured()) {
      await this.supabaseStore.saveRaw(rawItem);
    } else {
      this.store.saveRaw(rawItem);
    }

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

    if (this.supabaseStore.isConfigured()) {
      await this.supabaseStore.saveParsed(parsedItem);
    } else {
      this.store.saveParsed(parsedItem);
    }

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

    if (this.supabaseStore.isConfigured()) {
      await this.supabaseStore.saveReview(reviewItem);
    } else {
      this.store.saveReview(reviewItem);
    }

    return {
      rawItem,
      parsedItem,
      reviewItem,
    };
  }

  async updateReviewStatus(id: string, status: ReviewStatus, reviewerNotes?: string) {
    if (this.supabaseStore.isConfigured()) {
      return this.supabaseStore.updateReviewStatus(id, status, reviewerNotes);
    }

    return this.store.updateReviewStatus(id, status, reviewerNotes);
  }

  async publishReviewItem(id: string, reviewerNotes?: string): Promise<PublishedContentItem | null> {
    const now = new Date().toISOString();

    if (this.supabaseStore.isConfigured()) {
      const reviewItem = await this.supabaseStore.getReviewById(id);
      if (!reviewItem) {
        return null;
      }

      if (reviewItem.status === 'rejected') {
        throw new Error('Reddedilen icerik yayinlanamaz.');
      }

      if (reviewItem.status !== 'approved' && reviewItem.status !== 'published') {
        throw new Error('Icerigi yayinlamadan once approved durumuna almalisin.');
      }

      const parsedItem = await this.supabaseStore.getParsedById(reviewItem.parsedSignalId);
      if (!parsedItem) {
        throw new Error('Publish icin gerekli parse sonucu bulunamadi.');
      }

      const existing = await this.supabaseStore.getPublishedByReviewId(reviewItem.id, reviewItem.publishTarget);
      const publishedItem: PublishedContentItem = {
        id: existing?.id || randomUUID(),
        reviewQueueId: reviewItem.id,
        parsedSignalId: reviewItem.parsedSignalId,
        rawIngestId: reviewItem.rawIngestId,
        publishTarget: reviewItem.publishTarget,
        title: reviewItem.title,
        summary: reviewItem.summary,
        impactSummary: reviewItem.impactSummary,
        category: reviewItem.category,
        confidence: reviewItem.confidence,
        sourceName: reviewItem.sourceName,
        sourceUrl: reviewItem.sourceUrl,
        facts: parsedItem.facts,
        reviewerNotes: reviewerNotes ?? reviewItem.reviewerNotes,
        publishedAt: existing?.publishedAt || now,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };

      const saved = await this.supabaseStore.savePublished(publishedItem);
      await this.supabaseStore.updateReviewStatus(id, 'published', publishedItem.reviewerNotes);
      return saved || publishedItem;
    }

    const reviewItem = this.store.getReviewById(id);
    if (!reviewItem) {
      return null;
    }

    if (reviewItem.status === 'rejected') {
      throw new Error('Reddedilen icerik yayinlanamaz.');
    }

    if (reviewItem.status !== 'approved' && reviewItem.status !== 'published') {
      throw new Error('Icerigi yayinlamadan once approved durumuna almalisin.');
    }

    const parsedItem = this.store.getParsedById(reviewItem.parsedSignalId);
    if (!parsedItem) {
      throw new Error('Publish icin gerekli parse sonucu bulunamadi.');
    }

    const existing = this.store.getPublishedByReviewId(reviewItem.id);
    const publishedItem: PublishedContentItem = {
      id: existing?.id || randomUUID(),
      reviewQueueId: reviewItem.id,
      parsedSignalId: reviewItem.parsedSignalId,
      rawIngestId: reviewItem.rawIngestId,
      publishTarget: reviewItem.publishTarget,
      title: reviewItem.title,
      summary: reviewItem.summary,
      impactSummary: reviewItem.impactSummary,
      category: reviewItem.category,
      confidence: reviewItem.confidence,
      sourceName: reviewItem.sourceName,
      sourceUrl: reviewItem.sourceUrl,
      facts: parsedItem.facts,
      reviewerNotes: reviewerNotes ?? reviewItem.reviewerNotes,
      publishedAt: existing?.publishedAt || now,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    const saved = this.store.savePublished(publishedItem);
    this.store.updateReviewStatus(id, 'published', publishedItem.reviewerNotes);
    return saved;
  }
}