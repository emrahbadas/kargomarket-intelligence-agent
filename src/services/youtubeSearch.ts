import { env } from '../config/env.js';
import { fetchTranscript } from 'youtube-transcript';

const YOUTUBE_SEARCH_ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_VIDEOS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';
const YOUTUBE_CHANNELS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/channels';
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 30;
const DEFAULT_PUBLISHED_AFTER_HOURS = 24 * 30;
const MAX_CHANNEL_FILTERS = 12;
const MAX_TRANSCRIPT_WINDOW_MS = 3 * 60 * 1000;
const MAX_TRANSCRIPT_CHARS = 2200;

interface YouTubeSearchApiItem {
  id?: {
    videoId?: string;
  };
  snippet?: {
    title?: string;
    description?: string;
    channelId?: string;
    channelTitle?: string;
    publishedAt?: string;
    thumbnails?: {
      high?: { url?: string };
      medium?: { url?: string };
      default?: { url?: string };
    };
  };
}

interface YouTubeVideoDetailsApiItem {
  id?: string;
  contentDetails?: {
    duration?: string;
    caption?: string;
  };
  statistics?: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
  };
}

interface YouTubeChannelApiItem {
  id?: string;
  snippet?: {
    title?: string;
    customUrl?: string;
  };
}

export interface YouTubeSearchInput {
  keywords: string[];
  channelFilters?: string[];
  limit?: number;
  publishedAfterHours?: number;
}

export interface ResolvedYouTubeChannel {
  input: string;
  channelId: string;
  title: string;
  handle: string | null;
  url: string | null;
}

export interface YouTubeSearchItem {
  videoId: string;
  title: string;
  description: string;
  channelId: string | null;
  channelTitle: string;
  channelUrl: string | null;
  publishedAt: string | null;
  url: string;
  thumbnailUrl: string | null;
  duration: string | null;
  transcriptLikelyAvailable: boolean;
  transcriptFetched: boolean;
  transcriptExcerpt: string | null;
  transcriptLanguage: string | null;
  transcriptSegmentCount: number;
  matchedKeywords: string[];
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  rawText: string;
}

export interface YouTubeSearchSummary {
  searchedAt: string;
  query: string;
  keywordCount: number;
  itemCount: number;
  publishedAfterHours: number;
  channelCount: number;
  resolvedChannels: ResolvedYouTubeChannel[];
  unresolvedChannels: string[];
}

interface YouTubeSearchCandidate extends Omit<YouTubeSearchItem, 'rawText' | 'transcriptFetched' | 'transcriptExcerpt' | 'transcriptLanguage' | 'transcriptSegmentCount'> {}

interface TranscriptSnippetResult {
  fetched: boolean;
  excerpt: string | null;
  language: string | null;
  segmentCount: number;
}

const normalizeKeywords = (keywords: string[]) => Array.from(new Set(
  keywords
    .map((item) => String(item || '').trim())
    .filter((item) => item.length >= 2),
));

const normalizeChannelFilters = (values: string[] | undefined) => Array.from(new Set(
  (values || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, MAX_CHANNEL_FILTERS),
));

const buildSearchQuery = (keyword: string) => keyword
  .split(/\s+/)
  .map((part) => part.trim())
  .filter(Boolean)
  .join(' ');

const parseNullableNumber = (value: string | undefined) => {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeDescription = (value: string | undefined) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 3200);

const normalizeTranscriptLine = (value: string) => String(value || '')
  .replace(/\[[^\]]*\]/g, ' ')
  .replace(/[♪♫]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const isTranscriptFiller = (value: string) => {
  const normalized = value.toLowerCase();
  return !normalized
    || normalized.length < 3
    || normalized === 'foreign'
    || normalized === 'music'
    || normalized === 'alkış'
    || /^(hmm+|umm+|uh+|eee+|şey+|evet+|tamam+|arkadaşlar+)$/.test(normalized);
};

const parseChannelInput = (value: string) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }

  if (/^UC[\w-]{10,}$/.test(trimmed)) {
    return { type: 'id' as const, value: trimmed };
  }

  if (/^@/.test(trimmed)) {
    return { type: 'handle' as const, value: trimmed.replace(/^@/, '') };
  }

  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] === 'channel' && segments[1]) {
      return { type: 'id' as const, value: segments[1] };
    }

    if (segments[0]?.startsWith('@')) {
      return { type: 'handle' as const, value: segments[0].replace(/^@/, '') };
    }

    if ((segments[0] === 'c' || segments[0] === 'user') && segments[1]) {
      return { type: 'query' as const, value: segments[1] };
    }
  } catch {
    // Treat as plain query.
  }

  return { type: 'query' as const, value: trimmed };
};

const formatHandle = (value: string | null | undefined) => {
  const normalized = String(value || '').trim();
  return normalized ? `@${normalized.replace(/^@/, '')}` : null;
};

const createChannelUrl = (channelId: string, handle?: string | null) => {
  const normalizedHandle = formatHandle(handle);
  return normalizedHandle
    ? `https://www.youtube.com/${normalizedHandle}`
    : `https://www.youtube.com/channel/${channelId}`;
};

const findMatchedKeywords = (title: string, description: string, keywords: string[]) => {
  const haystack = `${title}\n${description}`.toLowerCase();
  return keywords.filter((item) => haystack.includes(item.toLowerCase()));
};

const createRawText = (
  item: Omit<YouTubeSearchItem, 'rawText'>,
  query: string,
  resolvedChannels: ResolvedYouTubeChannel[],
) => {
  const lines = [
    'YouTube keyword tarama sonucu',
    `Aranan kelimeler: ${query}`,
    resolvedChannels.length ? `Kanal filtresi: ${resolvedChannels.map((channel) => channel.title).join(', ')}` : null,
    `Video basligi: ${item.title}`,
    `Kanal: ${item.channelTitle}`,
    item.publishedAt ? `Yayin tarihi: ${item.publishedAt}` : null,
    item.duration ? `Sure: ${item.duration}` : null,
    item.matchedKeywords.length ? `Eslesen kelimeler: ${item.matchedKeywords.join(', ')}` : null,
    `Video URL: ${item.url}`,
    item.channelUrl ? `Kanal URL: ${item.channelUrl}` : null,
    item.description ? `Aciklama: ${item.description}` : null,
    item.transcriptExcerpt ? `Transcript ilk 3 dakika ozeti: ${item.transcriptExcerpt}` : null,
    item.transcriptExcerpt
      ? 'Not: Transcript kesiti ilk 3 dakikadan temizlenmis, tekrarlar ve dolgu ifadeleri filtrelenmis ham haberlestirme verisidir.'
      : item.transcriptLikelyAvailable
        ? 'Not: Transcript denenedi ama anlamli kesit alinamadi; baslik ve aciklama agirlikli ozet cikar.'
        : 'Not: Bu videoda transcript bilgisi dogrulanamadi; baslik ve aciklama agirlikli ozet cikar.',
  ].filter((value): value is string => Boolean(value));

  return lines.join('\n\n');
};

const fetchJson = async <T>(url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`YouTube API hatasi: ${text.slice(0, 220)}`);
  }

  return response.json() as Promise<T>;
};

const fetchSearchResults = async (keyword: string, maxResults: number, publishedAfterHours: number, channelId?: string) => {
  const params = new URLSearchParams({
    key: env.YOUTUBE_API_KEY!,
    part: 'snippet',
    type: 'video',
    order: 'date',
    q: buildSearchQuery(keyword),
    maxResults: String(maxResults),
    publishedAfter: new Date(Date.now() - publishedAfterHours * 60 * 60 * 1000).toISOString(),
    relevanceLanguage: 'tr',
    regionCode: 'TR',
  });

  if (channelId) {
    params.set('channelId', channelId);
  }

  const payload = await fetchJson<{ items?: YouTubeSearchApiItem[] }>(`${YOUTUBE_SEARCH_ENDPOINT}?${params.toString()}`);
  return Array.isArray(payload.items) ? payload.items : [];
};

const fetchChannelById = async (channelId: string) => {
  const params = new URLSearchParams({
    key: env.YOUTUBE_API_KEY!,
    part: 'snippet',
    id: channelId,
  });

  const payload = await fetchJson<{ items?: YouTubeChannelApiItem[] }>(`${YOUTUBE_CHANNELS_ENDPOINT}?${params.toString()}`);
  return payload.items?.[0] || null;
};

const fetchChannelByHandle = async (handle: string) => {
  const params = new URLSearchParams({
    key: env.YOUTUBE_API_KEY!,
    part: 'snippet',
    forHandle: handle.replace(/^@/, ''),
  });

  const payload = await fetchJson<{ items?: YouTubeChannelApiItem[] }>(`${YOUTUBE_CHANNELS_ENDPOINT}?${params.toString()}`);
  return payload.items?.[0] || null;
};

const searchChannelByQuery = async (query: string) => {
  const params = new URLSearchParams({
    key: env.YOUTUBE_API_KEY!,
    part: 'snippet',
    type: 'channel',
    q: query,
    maxResults: '1',
    regionCode: 'TR',
  });

  const payload = await fetchJson<{ items?: Array<{ snippet?: { channelId?: string; channelTitle?: string } }> }>(`${YOUTUBE_SEARCH_ENDPOINT}?${params.toString()}`);
  const first = payload.items?.[0];
  if (!first?.snippet?.channelId) {
    return null;
  }

  return {
    id: first.snippet.channelId,
    snippet: {
      title: first.snippet.channelTitle,
      customUrl: undefined,
    },
  } satisfies YouTubeChannelApiItem;
};

const resolveChannelFilter = async (input: string): Promise<ResolvedYouTubeChannel | null> => {
  const parsed = parseChannelInput(input);
  if (!parsed) {
    return null;
  }

  const channel = parsed.type === 'id'
    ? await fetchChannelById(parsed.value)
    : parsed.type === 'handle'
      ? await fetchChannelByHandle(parsed.value)
      : await searchChannelByQuery(parsed.value);

  const channelId = String(channel?.id || '').trim();
  if (!channelId) {
    return null;
  }

  const title = String(channel?.snippet?.title || input).trim() || input;
  const handle = formatHandle(channel?.snippet?.customUrl || (parsed.type === 'handle' ? parsed.value : null));

  return {
    input,
    channelId,
    title,
    handle,
    url: createChannelUrl(channelId, handle),
  };
};

const resolveChannelFilters = async (inputs: string[]) => {
  const resolved: ResolvedYouTubeChannel[] = [];
  const unresolved: string[] = [];
  const seenIds = new Set<string>();

  for (const input of inputs) {
    try {
      const result = await resolveChannelFilter(input);
      if (!result) {
        unresolved.push(input);
        continue;
      }

      if (!seenIds.has(result.channelId)) {
        seenIds.add(result.channelId);
        resolved.push(result);
      }
    } catch {
      unresolved.push(input);
    }
  }

  return { resolved, unresolved };
};

const fetchTranscriptSnippet = async (videoId: string): Promise<TranscriptSnippetResult> => {
  try {
    const rows = await fetchTranscript(videoId);
    const unique = new Set<string>();
    const segments: string[] = [];
    let language: string | null = null;

    for (const row of rows) {
      if (Number(row.offset) > MAX_TRANSCRIPT_WINDOW_MS) {
        break;
      }

      const normalized = normalizeTranscriptLine(row.text);
      if (isTranscriptFiller(normalized)) {
        continue;
      }

      const fingerprint = normalized.toLowerCase();
      if (unique.has(fingerprint)) {
        continue;
      }

      unique.add(fingerprint);
      segments.push(normalized);
      if (!language && row.lang) {
        language = row.lang;
      }

      if (segments.join(' ').length >= MAX_TRANSCRIPT_CHARS) {
        break;
      }
    }

    const excerpt = segments.join(' ').trim();
    return {
      fetched: Boolean(excerpt),
      excerpt: excerpt || null,
      language,
      segmentCount: segments.length,
    };
  } catch {
    return {
      fetched: false,
      excerpt: null,
      language: null,
      segmentCount: 0,
    };
  }
};

const fetchVideoDetails = async (videoIds: string[]) => {
  if (!videoIds.length) {
    return new Map<string, YouTubeVideoDetailsApiItem>();
  }

  const params = new URLSearchParams({
    key: env.YOUTUBE_API_KEY!,
    part: 'contentDetails,statistics',
    id: videoIds.join(','),
    maxResults: String(videoIds.length),
  });

  const payload = await fetchJson<{ items?: YouTubeVideoDetailsApiItem[] }>(`${YOUTUBE_VIDEOS_ENDPOINT}?${params.toString()}`);
  return new Map((payload.items || []).map((item) => [String(item.id || ''), item]));
};

const sortItems = <T extends { matchedKeywords: string[]; publishedAt: string | null; viewCount: number | null }>(items: T[]) => [...items].sort((left, right) => {
  const keywordDelta = right.matchedKeywords.length - left.matchedKeywords.length;
  if (keywordDelta !== 0) {
    return keywordDelta;
  }

  const publishedDelta = new Date(right.publishedAt || 0).getTime() - new Date(left.publishedAt || 0).getTime();
  if (publishedDelta !== 0) {
    return publishedDelta;
  }

  return (right.viewCount || 0) - (left.viewCount || 0);
});

export const searchYouTubeByKeywords = async (input: YouTubeSearchInput) => {
  if (!env.ENABLE_YOUTUBE_METADATA || !env.YOUTUBE_API_KEY) {
    throw new Error('YouTube arama ozelligi aktif degil. ENABLE_YOUTUBE_METADATA ve YOUTUBE_API_KEY gerekli.');
  }

  const keywords = normalizeKeywords(input.keywords);
  const channelFilters = normalizeChannelFilters(input.channelFilters);
  if (!keywords.length) {
    throw new Error('En az bir keyword gerekli.');
  }

  const limit = Math.max(1, Math.min(input.limit || DEFAULT_LIMIT, MAX_LIMIT));
  const publishedAfterHours = Math.max(1, Math.min(input.publishedAfterHours || DEFAULT_PUBLISHED_AFTER_HOURS, 24 * 180));
  const { resolved: resolvedChannels, unresolved: unresolvedChannels } = await resolveChannelFilters(channelFilters);
  if (channelFilters.length && !resolvedChannels.length) {
    throw new Error('YouTube kanal filtresi cozulmedi. Kanal URL, @handle veya UC... channel id gir.');
  }

  const searchTargets = resolvedChannels.length ? resolvedChannels : [null];
  const perTargetLimit = Math.max(3, Math.min(10, Math.ceil(limit / (keywords.length * searchTargets.length)) + 2));

  const deduped = new Map<string, YouTubeSearchApiItem>();
  for (const keyword of keywords) {
    for (const target of searchTargets) {
      const items = await fetchSearchResults(keyword, perTargetLimit, publishedAfterHours, target?.channelId);
      items.forEach((item) => {
        const videoId = String(item.id?.videoId || '').trim();
        if (!videoId) {
          return;
        }

        if (!deduped.has(videoId)) {
          deduped.set(videoId, item);
        }
      });
    }
  }

  const videoIds = Array.from(deduped.keys()).slice(0, MAX_LIMIT);
  const detailsMap = await fetchVideoDetails(videoIds);
  const query = keywords.join(', ');

  const candidates = sortItems(videoIds.map((videoId) => {
    const item = deduped.get(videoId);
    const snippet = item?.snippet || {};
    const details = detailsMap.get(videoId);
    const title = String(snippet.title || '').trim() || 'YouTube video';
    const description = normalizeDescription(snippet.description);
    const handle = formatHandle(snippet.channelTitle ? null : null);

    return {
      videoId,
      title,
      description,
      channelId: snippet.channelId ? String(snippet.channelId) : null,
      channelTitle: String(snippet.channelTitle || 'YouTube').trim() || 'YouTube',
      channelUrl: snippet.channelId ? createChannelUrl(String(snippet.channelId), handle) : null,
      publishedAt: snippet.publishedAt ? String(snippet.publishedAt) : null,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnailUrl: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || null,
      duration: details?.contentDetails?.duration ? String(details.contentDetails.duration) : null,
      transcriptLikelyAvailable: String(details?.contentDetails?.caption || '').toLowerCase() === 'true',
      matchedKeywords: findMatchedKeywords(title, description, keywords),
      viewCount: parseNullableNumber(details?.statistics?.viewCount),
      likeCount: parseNullableNumber(details?.statistics?.likeCount),
      commentCount: parseNullableNumber(details?.statistics?.commentCount),
    } satisfies YouTubeSearchCandidate;
  })).slice(0, limit);

  const transcriptResults = await Promise.all(candidates.map(async (item) => ({
    videoId: item.videoId,
    transcript: await fetchTranscriptSnippet(item.videoId),
  })));
  const transcriptMap = new Map(transcriptResults.map((item) => [item.videoId, item.transcript]));

  const items = candidates.map((item) => {
    const transcript = transcriptMap.get(item.videoId) || {
      fetched: false,
      excerpt: null,
      language: null,
      segmentCount: 0,
    } satisfies TranscriptSnippetResult;

    const enrichedItem = {
      ...item,
      transcriptFetched: transcript.fetched,
      transcriptExcerpt: transcript.excerpt,
      transcriptLanguage: transcript.language,
      transcriptSegmentCount: transcript.segmentCount,
    } satisfies Omit<YouTubeSearchItem, 'rawText'>;

    return {
      ...enrichedItem,
      rawText: createRawText(enrichedItem, query, resolvedChannels),
    } satisfies YouTubeSearchItem;
  });

  return {
    summary: {
      searchedAt: new Date().toISOString(),
      query,
      keywordCount: keywords.length,
      itemCount: items.length,
      publishedAfterHours,
      channelCount: resolvedChannels.length,
      resolvedChannels,
      unresolvedChannels,
    } satisfies YouTubeSearchSummary,
    items,
  };
};