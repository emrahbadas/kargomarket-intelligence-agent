import type { ParsedSignal, RawIngestItem, ReviewQueueItem, ReviewStatus } from '../domain/types.js';

export class InMemoryStore {
  private readonly rawItems = new Map<string, RawIngestItem>();
  private readonly parsedItems = new Map<string, ParsedSignal>();
  private readonly reviewItems = new Map<string, ReviewQueueItem>();

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