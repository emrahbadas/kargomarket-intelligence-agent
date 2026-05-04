import 'dotenv/config';
import { z } from 'zod';

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) {
    return fallback;
  }

  return value === 'true';
};

const parseInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseList = (value: string | undefined) => {
  if (!value) {
    return [] as string[];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.string().default('local'),
  PORT: z.number().int().positive(),
  LOG_LEVEL: z.string().default('info'),
  AGENT_API_TOKEN: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_SCHEMA: z.string().default('public'),
  SUPABASE_RAW_INGEST_TABLE: z.string().default('raw_content_ingest'),
  SUPABASE_PARSE_RESULTS_TABLE: z.string().default('content_parse_results'),
  SUPABASE_REVIEW_QUEUE_TABLE: z.string().default('content_review_queue'),
  SUPABASE_PUBLISHED_NEWS_TABLE: z.string().default('published_sector_news'),
  SUPABASE_PUBLISHED_SIGNALS_TABLE: z.string().default('published_market_signals'),
  DEFAULT_MODEL_PROVIDER: z.enum(['disabled', 'openai', 'perplexity']).default('openai'),
  MODEL_TIMEOUT_MS: z.number().int().positive(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  PERPLEXITY_API_KEY: z.string().optional(),
  PERPLEXITY_BASE_URL: z.string().default('https://api.perplexity.ai'),
  PERPLEXITY_MODEL: z.string().default('sonar'),
  ENABLE_PERPLEXITY_CORROBORATION: z.boolean(),
  ENABLE_RSS_SOURCES: z.boolean(),
  ENABLE_OFFICIAL_HTTP_SOURCES: z.boolean(),
  ENABLE_TELEGRAM_USER_SOURCE: z.boolean(),
  ENABLE_YOUTUBE_METADATA: z.boolean(),
  YOUTUBE_API_KEY: z.string().optional(),
  TELEGRAM_API_ID: z.string().optional(),
  TELEGRAM_API_HASH: z.string().optional(),
  TELEGRAM_PHONE_NUMBER: z.string().optional(),
  TELEGRAM_SESSION_STRING: z.string().optional(),
  TELEGRAM_2FA_PASSWORD: z.string().optional(),
  TELEGRAM_SOURCE_CHANNELS: z.array(z.string()),
  ALLOWED_SOURCE_HOSTS: z.array(z.string()),
  MAX_SOURCE_ITEMS_PER_RUN: z.number().int().positive(),
  ENABLE_REDIS: z.boolean(),
  REDIS_URL: z.string().optional(),
  REVIEW_AUTOPUBLISH_ENABLED: z.boolean(),
  REVIEW_AUTOPUBLISH_MIN_CONFIDENCE: z.number().min(0).max(1),
});

export const env = envSchema.parse({
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  APP_ENV: process.env.APP_ENV ?? 'local',
  PORT: parseInteger(process.env.PORT, 3001),
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  AGENT_API_TOKEN: process.env.AGENT_API_TOKEN,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_SCHEMA: process.env.SUPABASE_SCHEMA ?? 'public',
  SUPABASE_RAW_INGEST_TABLE: process.env.SUPABASE_RAW_INGEST_TABLE ?? 'raw_content_ingest',
  SUPABASE_PARSE_RESULTS_TABLE: process.env.SUPABASE_PARSE_RESULTS_TABLE ?? 'content_parse_results',
  SUPABASE_REVIEW_QUEUE_TABLE: process.env.SUPABASE_REVIEW_QUEUE_TABLE ?? 'content_review_queue',
  SUPABASE_PUBLISHED_NEWS_TABLE: process.env.SUPABASE_PUBLISHED_NEWS_TABLE ?? 'published_sector_news',
  SUPABASE_PUBLISHED_SIGNALS_TABLE: process.env.SUPABASE_PUBLISHED_SIGNALS_TABLE ?? 'published_market_signals',
  DEFAULT_MODEL_PROVIDER: process.env.DEFAULT_MODEL_PROVIDER ?? 'openai',
  MODEL_TIMEOUT_MS: parseInteger(process.env.MODEL_TIMEOUT_MS, 20_000),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  OPENAI_MODEL: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
  PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
  PERPLEXITY_BASE_URL: process.env.PERPLEXITY_BASE_URL ?? 'https://api.perplexity.ai',
  PERPLEXITY_MODEL: process.env.PERPLEXITY_MODEL ?? 'sonar',
  ENABLE_PERPLEXITY_CORROBORATION: parseBoolean(process.env.ENABLE_PERPLEXITY_CORROBORATION, false),
  ENABLE_RSS_SOURCES: parseBoolean(process.env.ENABLE_RSS_SOURCES, true),
  ENABLE_OFFICIAL_HTTP_SOURCES: parseBoolean(process.env.ENABLE_OFFICIAL_HTTP_SOURCES, true),
  ENABLE_TELEGRAM_USER_SOURCE: parseBoolean(process.env.ENABLE_TELEGRAM_USER_SOURCE, false),
  ENABLE_YOUTUBE_METADATA: parseBoolean(process.env.ENABLE_YOUTUBE_METADATA, false),
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,
  TELEGRAM_API_ID: process.env.TELEGRAM_API_ID,
  TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH,
  TELEGRAM_PHONE_NUMBER: process.env.TELEGRAM_PHONE_NUMBER,
  TELEGRAM_SESSION_STRING: process.env.TELEGRAM_SESSION_STRING,
  TELEGRAM_2FA_PASSWORD: process.env.TELEGRAM_2FA_PASSWORD,
  TELEGRAM_SOURCE_CHANNELS: parseList(process.env.TELEGRAM_SOURCE_CHANNELS),
  ALLOWED_SOURCE_HOSTS: parseList(process.env.ALLOWED_SOURCE_HOSTS),
  MAX_SOURCE_ITEMS_PER_RUN: parseInteger(process.env.MAX_SOURCE_ITEMS_PER_RUN, 20),
  ENABLE_REDIS: parseBoolean(process.env.ENABLE_REDIS, false),
  REDIS_URL: process.env.REDIS_URL,
  REVIEW_AUTOPUBLISH_ENABLED: parseBoolean(process.env.REVIEW_AUTOPUBLISH_ENABLED, false),
  REVIEW_AUTOPUBLISH_MIN_CONFIDENCE: parseNumber(process.env.REVIEW_AUTOPUBLISH_MIN_CONFIDENCE, 0.9),
});

export type AppEnv = typeof env;