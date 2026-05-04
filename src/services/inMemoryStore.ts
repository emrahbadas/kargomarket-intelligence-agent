import type { ParsedSignal, PublishedContentItem, PublishTarget, RawIngestItem, ReviewQueueItem, ReviewStatus } from '../domain/types.js';

export class InMemoryStore {
  private readonly rawItems = new Map<string, RawIngestItem>();
  private readonly parsedItems = new Map<string, ParsedSignal>();
  private readonly reviewItems = new Map<string, ReviewQueueItem>();
  private readonly publishedItems = new Map<string, PublishedContentItem>();

  saveRaw(item: RawIngestItem) {
    this.rawItems.set(item.id, item);
  }

  saveParsed(item: ParsedSignal) {
    this.parsedItems.set(item.id, item);
  }

  saveReview(item: ReviewQueueItem) {
    this.reviewItems.set(item.id, item);
  }

  listReviews() {
    return [...this.reviewItems.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getReviewById(id: string) {
    return this.reviewItems.get(id) || null;
  }

  getParsedById(id: string) {
    return this.parsedItems.get(id) || null;
  }

  getPublishedByReviewId(reviewQueueId: string) {
    return this.publishedItems.get(reviewQueueId) || null;
  }

  savePublished(item: PublishedContentItem) {
    this.publishedItems.set(item.reviewQueueId, item);
    return item;
  }

  listPublished(target?: PublishTarget) {
    return [...this.publishedItems.values()]
      .filter((item) => !target || item.publishTarget === target)
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
  }

  updateReviewStatus(id: string, status: ReviewStatus, reviewerNotes?: string) {
    const current = this.reviewItems.get(id);
    if (!current) {
      return null;
    }

    const updated: ReviewQueueItem = {
      ...current,
      status,
      reviewerNotes,
      updatedAt: new Date().toISOString(),
    };

    this.reviewItems.set(id, updated);
    return updated;
  }

  stats() {
    return {
      rawCount: this.rawItems.size,
      parsedCount: this.parsedItems.size,
      reviewCount: this.reviewItems.size,
    };
  }
}