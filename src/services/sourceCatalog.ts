import { env } from '../config/env.js';
import type { SourceRecord } from '../domain/types.js';

const hostAllowed = (source: SourceRecord) => {
  if (source.kind === 'telegram-user' || source.kind === 'manual') {
    return true;
  }

  const hostname = new URL(source.url).hostname.replace(/^www\./, '');
  return env.ALLOWED_SOURCE_HOSTS.length === 0 || env.ALLOWED_SOURCE_HOSTS.includes(hostname);
};

const seededSources: SourceRecord[] = [
  {
    id: 'epdk-announcements',
    name: 'EPDK Duyurular',
    kind: 'official-bulletin',
    url: 'https://www.epdk.gov.tr/',
    enabled: env.ENABLE_OFFICIAL_HTTP_SOURCES,
    trustScore: 0.99,
    tags: ['fuel', 'energy', 'regulation'],
  },
  {
    id: 'resmi-gazete',
    name: 'Resmi Gazete',
    kind: 'official-bulletin',
    url: 'https://www.resmigazete.gov.tr/',
    enabled: env.ENABLE_OFFICIAL_HTTP_SOURCES,
    trustScore: 0.99,
    tags: ['regulation', 'customs', 'law'],
  },
  {
    id: 'afad-duyurular',
    name: 'AFAD',
    kind: 'official-bulletin',
    url: 'https://www.afad.gov.tr/',
    enabled: env.ENABLE_OFFICIAL_HTTP_SOURCES,
    trustScore: 0.98,
    tags: ['weather', 'disaster', 'route'],
  },
  {
    id: 'meteoroloji',
    name: 'Meteoroloji Genel Mudurlugu',
    kind: 'official-bulletin',
    url: 'https://www.mgm.gov.tr/',
    enabled: env.ENABLE_OFFICIAL_HTTP_SOURCES,
    trustScore: 0.97,
    tags: ['weather', 'storm', 'route'],
  },
  {
    id: 'telegram-user-mtproto',
    name: 'Telegram User Session (MTProto)',
    kind: 'telegram-user',
    url: 'https://telegram.org/',
    enabled: env.ENABLE_TELEGRAM_USER_SOURCE,
    trustScore: 0.6,
    tags: ['community', 'telegram', 'mtproto', 'user-session', 'review-required'],
  },
];

export const getSourceCatalog = () => seededSources.filter((source) => hostAllowed(source));