import { env } from '../config/env.js';
import type { ParsedSignal, PublishedContentItem, PublishTarget, RawIngestItem, ReviewQueueItem, ReviewStatus } from '../domain/types.js';

interface ParsedSignalRow {
  id: string;
  raw_ingest_id: string;
  category: string;
  title: string;
  summary: string;
  impact_summary: string;
  confidence: number;
  facts: Record<string, string | number | boolean | null>;
  created_at: string;
}

interface ReviewQueueRow {
  id: string;
  parsed_signal_id: string;
  raw_ingest_id: string;
  status: ReviewStatus;
  publish_target: 'sector-news' | 'market-signal';
  title: string;
  summary: string;
  impact_summary: string;
  category: string;
  confidence: number;
  source_name: string;
  source_url?: string | null;
  reviewer_notes?: string | null;
  created_at: string;
  updated_at: string;
}

interface PublishedContentRow {
  id: string;
  review_queue_id: string;
  parsed_signal_id: string;
  raw_ingest_id: string;
  publish_target: PublishTarget;
  title: string;
  summary: string;
  impact_summary: string;
  category: string;
  confidence: number;
  source_name: string;
  source_url?: string | null;
  facts: Record<string, string | number | boolean | null>;
  reviewer_notes?: string | null;
  published_at: string;
  created_at: string;
  updated_at: string;
}

const toErrorMessage = async (response: Response) => {
  const fallback = `${response.status} ${response.statusText}`.trim();

  try {
    const body = await response.json() as { message?: string; error?: string; hint?: string };
    return body.message || body.error || body.hint || fallback;
  } catch {
    return fallback;
  }
};

const mapReviewQueueRow = (row: ReviewQueueRow): ReviewQueueItem => ({
  id: row.id,
  parsedSignalId: row.parsed_signal_id,
  rawIngestId: row.raw_ingest_id,
  status: row.status,
  publishTarget: row.publish_target,
  title: row.title,
  summary: row.summary,
  impactSummary: row.impact_summary,
  category: row.category as ReviewQueueItem['category'],
  confidence: Number(row.confidence || 0),
  sourceName: row.source_name,
  sourceUrl: row.source_url || undefined,
  reviewerNotes: row.reviewer_notes || undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapParsedRow = (row: ParsedSignalRow): ParsedSignal => ({
  id: row.id,
  rawIngestId: row.raw_ingest_id,
  category: row.category as ParsedSignal['category'],
  title: row.title,
  summary: row.summary,
  impactSummary: row.impact_summary,
  confidence: Number(row.confidence || 0),
  facts: row.facts || {},
  createdAt: row.created_at,
});

const mapPublishedRow = (row: PublishedContentRow): PublishedContentItem => ({
  id: row.id,
  reviewQueueId: row.review_queue_id,
  parsedSignalId: row.parsed_signal_id,
  rawIngestId: row.raw_ingest_id,
  publishTarget: row.publish_target,
  title: row.title,
  summary: row.summary,
  impactSummary: row.impact_summary,
  category: row.category as PublishedContentItem['category'],
  confidence: Number(row.confidence || 0),
  sourceName: row.source_name,
  sourceUrl: row.source_url || undefined,
  facts: row.facts || {},
  reviewerNotes: row.reviewer_notes || undefined,
  publishedAt: row.published_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class SupabasePipelineStore {
  private readonly baseUrl = env.SUPABASE_URL ? env.SUPABASE_URL.replace(/\/+$/, '') : '';
  private readonly serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
  private readonly schema = env.SUPABASE_SCHEMA || 'public';

  isConfigured() {
    return Boolean(this.baseUrl && this.serviceRoleKey);
  }

  private getHeaders(includeContentType = false, prefer?: string) {
    const headers: Record<string, string> = {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      Accept: 'application/json',
      'Accept-Profile': this.schema,
    };

    if (includeContentType) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Profile'] = this.schema;
    }

    if (prefer) {
      headers.Prefer = prefer;
    }

    return headers;
  }

  async saveRaw(item: RawIngestItem) {
    if (!this.isConfigured()) {
      return;
    }

    const response = await fetch(`${this.baseUrl}/rest/v1/${env.SUPABASE_RAW_INGEST_TABLE}`, {
      method: 'POST',
      headers: this.getHeaders(true, 'return=minimal'),
      body: JSON.stringify([{
        id: item.id,
        source_id: item.sourceId,
        source_name: item.sourceName,
        title: item.title,
        raw_text: item.rawText,
        source_url: item.sourceUrl ?? null,
        published_at: item.publishedAt,
        checksum: item.checksum,
        created_at: item.createdAt,
      }]),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }
  }

  async saveParsed(item: ParsedSignal) {
    if (!this.isConfigured()) {
      return;
    }

    const response = await fetch(`${this.baseUrl}/rest/v1/${env.SUPABASE_PARSE_RESULTS_TABLE}`, {
      method: 'POST',
      headers: this.getHeaders(true, 'return=minimal'),
      body: JSON.stringify([{
        id: item.id,
        raw_ingest_id: item.rawIngestId,
        category: item.category,
        title: item.title,
        summary: item.summary,
        impact_summary: item.impactSummary,
        confidence: item.confidence,
        facts: item.facts,
        created_at: item.createdAt,
      }]),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }
  }

  async saveReview(item: ReviewQueueItem) {
    if (!this.isConfigured()) {
      return;
    }

    const response = await fetch(`${this.baseUrl}/rest/v1/${env.SUPABASE_REVIEW_QUEUE_TABLE}`, {
      method: 'POST',
      headers: this.getHeaders(true, 'return=minimal'),
      body: JSON.stringify([{
        id: item.id,
        parsed_signal_id: item.parsedSignalId,
        raw_ingest_id: item.rawIngestId,
        status: item.status,
        publish_target: item.publishTarget,
        title: item.title,
        summary: item.summary,
        impact_summary: item.impactSummary,
        category: item.category,
        confidence: item.confidence,
        source_name: item.sourceName,
        source_url: item.sourceUrl ?? null,
        reviewer_notes: item.reviewerNotes ?? null,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      }]),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }
  }

  async listReviews() {
    if (!this.isConfigured()) {
      return [] as ReviewQueueItem[];
    }

    const query = new URLSearchParams({
      select: 'id,parsed_signal_id,raw_ingest_id,status,publish_target,title,summary,impact_summary,category,confidence,source_name,source_url,reviewer_notes,created_at,updated_at',
      order: 'created_at.desc',
      limit: '200',
    });

    const response = await fetch(`${this.baseUrl}/rest/v1/${env.SUPABASE_REVIEW_QUEUE_TABLE}?${query.toString()}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    const rows = await response.json() as ReviewQueueRow[];
    return rows.map(mapReviewQueueRow);
  }

  async getReviewById(id: string) {
    if (!this.isConfigured()) {
      return null;
    }

    const response = await fetch(`${this.baseUrl}/rest/v1/${env.SUPABASE_REVIEW_QUEUE_TABLE}?select=id,parsed_signal_id,raw_ingest_id,status,publish_target,title,summary,impact_summary,category,confidence,source_name,source_url,reviewer_notes,created_at,updated_at&id=eq.${encodeURIComponent(id)}&limit=1`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    const rows = await response.json() as ReviewQueueRow[];
    return rows[0] ? mapReviewQueueRow(rows[0]) : null;
  }

  async getParsedById(id: string) {
    if (!this.isConfigured()) {
      return null;
    }

    const response = await fetch(`${this.baseUrl}/rest/v1/${env.SUPABASE_PARSE_RESULTS_TABLE}?select=id,raw_ingest_id,category,title,summary,impact_summary,confidence,facts,created_at&id=eq.${encodeURIComponent(id)}&limit=1`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    const rows = await response.json() as ParsedSignalRow[];
    return rows[0] ? mapParsedRow(rows[0]) : null;
  }

  async getPublishedByReviewId(reviewQueueId: string, publishTarget: PublishTarget) {
    if (!this.isConfigured()) {
      return null;
    }

    const tableName = this.getPublishedTableName(publishTarget);
    const response = await fetch(`${this.baseUrl}/rest/v1/${tableName}?select=id,review_queue_id,parsed_signal_id,raw_ingest_id,publish_target,title,summary,impact_summary,category,confidence,source_name,source_url,facts,reviewer_notes,published_at,created_at,updated_at&review_queue_id=eq.${encodeURIComponent(reviewQueueId)}&limit=1`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    const rows = await response.json() as PublishedContentRow[];
    return rows[0] ? mapPublishedRow(rows[0]) : null;
  }

  async savePublished(item: PublishedContentItem) {
    if (!this.isConfigured()) {
      return null;
    }

    const tableName = this.getPublishedTableName(item.publishTarget);
    const response = await fetch(`${this.baseUrl}/rest/v1/${tableName}?on_conflict=review_queue_id`, {
      method: 'POST',
      headers: this.getHeaders(true, 'resolution=merge-duplicates,return=representation'),
      body: JSON.stringify([{
        id: item.id,
        review_queue_id: item.reviewQueueId,
        parsed_signal_id: item.parsedSignalId,
        raw_ingest_id: item.rawIngestId,
        publish_target: item.publishTarget,
        title: item.title,
        summary: item.summary,
        impact_summary: item.impactSummary,
        category: item.category,
        confidence: item.confidence,
        source_name: item.sourceName,
        source_url: item.sourceUrl ?? null,
        facts: item.facts,
        reviewer_notes: item.reviewerNotes ?? null,
        published_at: item.publishedAt,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      }]),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    const rows = await response.json() as PublishedContentRow[];
    return rows[0] ? mapPublishedRow(rows[0]) : item;
  }

  async listPublished(target?: PublishTarget, limit = 100) {
    if (!this.isConfigured()) {
      return [] as PublishedContentItem[];
    }

    if (target) {
      return this.fetchPublishedRows(target, limit);
    }

    const [newsItems, signalItems] = await Promise.all([
      this.fetchPublishedRows('sector-news', limit),
      this.fetchPublishedRows('market-signal', limit),
    ]);

    return [...newsItems, ...signalItems]
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
      .slice(0, limit);
  }

  async updateReviewStatus(id: string, status: ReviewStatus, reviewerNotes?: string) {
    if (!this.isConfigured()) {
      return null;
    }

    const response = await fetch(`${this.baseUrl}/rest/v1/${env.SUPABASE_REVIEW_QUEUE_TABLE}?id=eq.${id}`, {
      method: 'PATCH',
      headers: this.getHeaders(true, 'return=representation'),
      body: JSON.stringify({
        status,
        reviewer_notes: reviewerNotes ?? null,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    const rows = await response.json() as ReviewQueueRow[];
    return rows[0] ? mapReviewQueueRow(rows[0]) : null;
  }

  async getStats() {
    if (!this.isConfigured()) {
      return {
        rawCount: 0,
        parsedCount: 0,
        reviewCount: 0,
      };
    }

    const [rawCount, parsedCount, reviewCount] = await Promise.all([
      this.fetchTableCount(env.SUPABASE_RAW_INGEST_TABLE),
      this.fetchTableCount(env.SUPABASE_PARSE_RESULTS_TABLE),
      this.fetchTableCount(env.SUPABASE_REVIEW_QUEUE_TABLE),
    ]);

    return {
      rawCount,
      parsedCount,
      reviewCount,
    };
  }

  private async fetchTableCount(tableName: string) {
    const response = await fetch(`${this.baseUrl}/rest/v1/${tableName}?select=id&limit=1`, {
      method: 'GET',
      headers: this.getHeaders(false, 'count=exact'),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    const contentRange = response.headers.get('content-range') || '';
    const total = Number(contentRange.split('/')[1] || '0');
    return Number.isFinite(total) ? total : 0;
  }

  private getPublishedTableName(target: PublishTarget) {
    return target === 'market-signal'
      ? env.SUPABASE_PUBLISHED_SIGNALS_TABLE
      : env.SUPABASE_PUBLISHED_NEWS_TABLE;
  }

  private async fetchPublishedRows(target: PublishTarget, limit: number) {
    const tableName = this.getPublishedTableName(target);
    const query = new URLSearchParams({
      select: 'id,review_queue_id,parsed_signal_id,raw_ingest_id,publish_target,title,summary,impact_summary,category,confidence,source_name,source_url,facts,reviewer_notes,published_at,created_at,updated_at',
      order: 'published_at.desc',
      limit: String(limit),
    });

    const response = await fetch(`${this.baseUrl}/rest/v1/${tableName}?${query.toString()}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    const rows = await response.json() as PublishedContentRow[];
    return rows.map(mapPublishedRow);
  }
}