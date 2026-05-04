export const contentCategoryValues = [
  'fuel',
  'customs',
  'weather',
  'route',
  'regulation',
  'supply-demand',
  'other',
] as const;

export type ContentCategory = (typeof contentCategoryValues)[number];

export const sourceKindValues = [
  'rss',
  'http-json',
  'official-bulletin',
  'telegram-user',
  'manual',
] as const;

export type SourceKind = (typeof sourceKindValues)[number];

export const reviewStatusValues = [
  'pending',
  'approved',
  'rejected',
  'needs_edit',
  'published',
] as const;

export type ReviewStatus = (typeof reviewStatusValues)[number];

export const publishTargetValues = ['sector-news', 'market-signal'] as const;

export type PublishTarget = (typeof publishTargetValues)[number];

export interface SourceRecord {
  id: string;
  name: string;
  kind: SourceKind;
  url: string;
  enabled: boolean;
  trustScore: number;
  tags: string[];
}

export interface RawIngestItem {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  rawText: string;
  sourceUrl?: string;
  publishedAt: string;
  checksum: string;
  createdAt: string;
}

export interface ParsedSignal {
  id: string;
  rawIngestId: string;
  category: ContentCategory;
  title: string;
  summary: string;
  impactSummary: string;
  confidence: number;
  facts: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface ReviewQueueItem {
  id: string;
  parsedSignalId: string;
  rawIngestId: string;
  status: ReviewStatus;
  publishTarget: PublishTarget;
  title: string;
  summary: string;
  impactSummary: string;
  category: ContentCategory;
  confidence: number;
  sourceName: string;
  sourceUrl?: string;
  reviewerNotes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DependencyHealth {
  models: 'ready' | 'disabled' | 'missing_key';
  supabase: 'configured' | 'not_configured';
  redis: 'configured' | 'disabled';
  telegramUser: 'configured' | 'disabled';
  youtube: 'configured' | 'disabled';
}

export interface ManualIngestInput {
  sourceName: string;
  title: string;
  rawText: string;
  sourceUrl?: string;
}