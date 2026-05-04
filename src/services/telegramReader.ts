import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { env } from '../config/env.js';

interface ResolvedChannel {
  entity: unknown;
  channelId: string;
  channelTitle: string;
}

interface ConfigureReaderInput {
  apiId?: string | number;
  apiHash?: string;
  sessionString?: string;
  sourceChannels?: string[];
}

interface ReaderStatus {
  configured: boolean;
  authenticated: boolean;
  connected: boolean;
  hasSession: boolean;
  sourceChannels: string[];
}

type InternalTelegramClient = TelegramClient & {
  _computeCheck?: (passwordInfo: unknown, password: string) => Promise<unknown>;
};

const normalizeText = (value: string) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const toIsoDate = (value: unknown) => {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    const millis = numericValue > 10_000_000_000 ? numericValue : numericValue * 1000;
    return new Date(millis).toISOString();
  }

  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const formatError = (error: unknown) => {
  if (error && typeof error === 'object') {
    const maybeError = error as { errorMessage?: string; message?: string };
    return maybeError.errorMessage || maybeError.message || 'Unknown Telegram error';
  }

  return String(error || 'Unknown Telegram error');
};

const uniqueStrings = (items: string[]) => {
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
};

export class TelegramReader {
  private client: InternalTelegramClient | null = null;
  private apiId: number | null = env.TELEGRAM_API_ID ? Number(env.TELEGRAM_API_ID) : null;
  private apiHash: string | null = env.TELEGRAM_API_HASH || null;
  private sessionString: string = env.TELEGRAM_SESSION_STRING || '';
  private sourceChannels: string[] = [...env.TELEGRAM_SOURCE_CHANNELS];
  private phoneCodeHash: string | null = null;
  private lastPhoneNumber: string | null = env.TELEGRAM_PHONE_NUMBER || null;
  private connected = false;

  private ensureConfigured() {
    if (!this.apiId || !this.apiHash) {
      throw new Error('Telegram API ID ve API Hash ayarlanmamis.');
    }
  }

  private createClient() {
    this.ensureConfigured();

    return new TelegramClient(
      new StringSession(this.sessionString || ''),
      this.apiId as number,
      this.apiHash as string,
      {
        connectionRetries: 3,
        useWSS: true,
        deviceModel: 'KargoMarket Intelligence Agent',
        appVersion: '0.1.0',
        systemVersion: 'Node.js',
      },
    ) as InternalTelegramClient;
  }

  private resetClient() {
    if (this.client) {
      void this.client.disconnect().catch(() => undefined);
    }

    this.client = null;
    this.connected = false;
  }

  async disconnect() {
    if (!this.client || !this.connected) {
      return;
    }

    await this.client.disconnect();
    this.connected = false;
  }

  configure(input: ConfigureReaderInput) {
    if (input.apiId !== undefined) {
      const parsed = Number(input.apiId);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('Telegram API ID gecersiz.');
      }

      this.apiId = parsed;
    }

    if (input.apiHash !== undefined) {
      const hash = String(input.apiHash || '').trim();
      if (!hash) {
        throw new Error('Telegram API Hash bos olamaz.');
      }

      this.apiHash = hash;
    }

    if (input.sessionString !== undefined) {
      this.sessionString = String(input.sessionString || '');
    }

    if (Array.isArray(input.sourceChannels)) {
      this.sourceChannels = uniqueStrings(input.sourceChannels);
    }

    this.resetClient();
    return this.getStatus();
  }

  getStatus(): ReaderStatus {
    const configured = Boolean(this.apiId && this.apiHash);
    const hasSession = Boolean(this.sessionString && this.sessionString.length > 10);

    return {
      configured,
      authenticated: hasSession,
      connected: this.connected,
      hasSession,
      sourceChannels: [...this.sourceChannels],
    };
  }

  getSessionString() {
    if (this.client) {
      const latest = String((this.client.session as unknown as StringSession).save() || '');
      if (latest) {
        this.sessionString = latest;
      }
    }

    return this.sessionString;
  }

  async connect() {
    this.ensureConfigured();

    if (!this.client) {
      this.client = this.createClient();
    }

    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
  }

  private async resolveChannelEntity(channelRef: string): Promise<ResolvedChannel> {
    await this.connect();

    if (!this.client) {
      throw new Error('Telegram client olusturulamadi.');
    }

    const raw = String(channelRef || '').trim();
    if (!raw) {
      throw new Error('Kanal referansi bos.');
    }

    const directCandidates: string[] = [];
    if (/^-?\d+$/.test(raw)) {
      directCandidates.push(raw);
    } else {
      directCandidates.push(raw);
      if (!raw.startsWith('@')) {
        directCandidates.push(`@${raw}`);
      }
    }

    for (const candidate of directCandidates) {
      try {
        const entity = await this.client.getEntity(candidate);
        const entityRecord = entity as unknown as Record<string, unknown>;
        return {
          entity,
          channelId: String(entityRecord.id || raw),
          channelTitle: String(entityRecord.title || entityRecord.username || raw),
        };
      } catch {
        // Try next candidate.
      }
    }

    const channels = await this.getJoinedChannels();
    const normalizedRaw = normalizeText(raw.replace(/^@/, ''));

    const exactMatch = channels.find((channel) => {
      const id = normalizeText(channel.id);
      const title = normalizeText(channel.title);
      const username = normalizeText((channel.username || '').replace(/^@/, ''));
      return normalizedRaw === id || normalizedRaw === title || normalizedRaw === username;
    });

    const fuzzyMatch = exactMatch || channels.find((channel) => {
      const title = normalizeText(channel.title);
      const username = normalizeText((channel.username || '').replace(/^@/, ''));
      return (title && (title.includes(normalizedRaw) || normalizedRaw.includes(title)))
        || (username && (username.includes(normalizedRaw) || normalizedRaw.includes(username)));
    });

    if (fuzzyMatch) {
      const fallbackCandidates: string[] = [];

      if (fuzzyMatch.username) {
        fallbackCandidates.push(`@${String(fuzzyMatch.username).replace(/^@/, '')}`);
      }

      if (fuzzyMatch.id && /^-?\d+$/.test(String(fuzzyMatch.id))) {
        fallbackCandidates.push(String(fuzzyMatch.id));
      }

      fallbackCandidates.push(fuzzyMatch.title);

      for (const candidate of fallbackCandidates) {
        try {
          const entity = await this.client.getEntity(candidate);
          const entityRecord = entity as unknown as Record<string, unknown>;

          return {
            entity,
            channelId: String(fuzzyMatch.id || entityRecord.id || raw),
            channelTitle: String(fuzzyMatch.title || entityRecord.title || entityRecord.username || raw),
          };
        } catch {
          // Try next fallback candidate.
        }
      }
    }

    throw new Error(`Kanal bulunamadi: ${raw}`);
  }

  async sendCode(phoneNumber?: string, forceSMS = false) {
    const phone = String(phoneNumber || this.lastPhoneNumber || env.TELEGRAM_PHONE_NUMBER || '').trim();
    if (!phone) {
      throw new Error('Telefon numarasi gerekli.');
    }

    await this.connect();

    if (!this.client) {
      throw new Error('Telegram client olusturulamadi.');
    }

    const result = await this.client.sendCode(
      {
        apiId: this.apiId as number,
        apiHash: this.apiHash as string,
      },
      phone,
      forceSMS,
    );

    this.lastPhoneNumber = phone;
    this.phoneCodeHash = String(result.phoneCodeHash || '');
    const isCodeViaApp = Boolean((result as { isCodeViaApp?: boolean }).isCodeViaApp);

    return {
      phoneCodeHash: this.phoneCodeHash,
      phoneNumber: phone,
      isCodeViaApp,
      forceSmsRequested: Boolean(forceSMS),
    };
  }

  async verifyCode(code: string, phoneNumber?: string, phoneCodeHash?: string) {
    await this.connect();

    if (!this.client) {
      throw new Error('Telegram client olusturulamadi.');
    }

    const phone = String(phoneNumber || this.lastPhoneNumber || env.TELEGRAM_PHONE_NUMBER || '').trim();
    const hash = String(phoneCodeHash || this.phoneCodeHash || '').trim();
    const safeCode = String(code || '').trim();

    if (!phone) {
      throw new Error('Telefon numarasi gerekli.');
    }

    if (!hash) {
      throw new Error('phoneCodeHash gerekli.');
    }

    if (!safeCode) {
      throw new Error('Dogrulama kodu gerekli.');
    }

    try {
      await this.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash: hash,
          phoneCode: safeCode,
        }),
      );
    } catch (error) {
      const message = formatError(error);
      if (message.includes('SESSION_PASSWORD_NEEDED')) {
        return {
          status: 'need_2fa' as const,
          message: '2FA sifresi gerekli.',
        };
      }

      throw new Error(message);
    }

    this.sessionString = String((this.client.session as unknown as StringSession).save() || '');
    this.phoneCodeHash = null;

    return {
      status: 'ok' as const,
      message: 'Telegram girisi basarili.',
      sessionString: this.sessionString,
    };
  }

  async verify2FA(password?: string) {
    await this.connect();

    if (!this.client) {
      throw new Error('Telegram client olusturulamadi.');
    }

    const effectivePassword = String(password || env.TELEGRAM_2FA_PASSWORD || '').trim();
    if (!effectivePassword) {
      throw new Error('2FA sifresi gerekli.');
    }

    const passwordInfo = await this.client.invoke(new Api.account.GetPassword());
    const computed = await (this.client._computeCheck?.(passwordInfo, effectivePassword));

    if (!computed) {
      throw new Error('2FA sifresi dogrulanamadi.');
    }

    await this.client.invoke(
      new Api.auth.CheckPassword({
        password: computed as unknown as Api.TypeInputCheckPasswordSRP,
      }),
    );

    this.sessionString = String((this.client.session as unknown as StringSession).save() || '');

    return {
      status: 'ok' as const,
      message: '2FA dogrulamasi basarili.',
      sessionString: this.sessionString,
    };
  }

  getTrackedChannels() {
    return [...this.sourceChannels];
  }

  setTrackedChannels(channels: string[]) {
    this.sourceChannels = uniqueStrings(channels);
    return this.getTrackedChannels();
  }

  async getJoinedChannels(limit = 200) {
    await this.connect();

    if (!this.client) {
      throw new Error('Telegram client olusturulamadi.');
    }

    const dialogs = await this.client.getDialogs({
      limit: Math.max(1, Math.min(Number(limit) || 200, 500)),
    });

    return dialogs
      .filter((dialog) => {
        const value = dialog as unknown as { isChannel?: boolean; isGroup?: boolean };
        return Boolean(value.isChannel || value.isGroup);
      })
      .map((dialog) => {
        const value = dialog as unknown as {
          id?: unknown;
          title?: string;
          name?: string;
          isChannel?: boolean;
          isGroup?: boolean;
          entity?: { username?: string; participantsCount?: number };
        };

        return {
          id: String(value.id || ''),
          title: value.title || value.name || 'Adsiz',
          username: value.entity?.username || null,
          participantsCount: Number(value.entity?.participantsCount || 0),
          isChannel: Boolean(value.isChannel),
          isGroup: Boolean(value.isGroup),
        };
      });
  }

  async readChannelMessages(channelRef: string, limit = 20) {
    await this.connect();

    if (!this.client) {
      throw new Error('Telegram client olusturulamadi.');
    }

    const resolved = await this.resolveChannelEntity(channelRef);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
    const messages = await this.client.getMessages(resolved.entity as never, { limit: safeLimit });

    return messages
      .filter((message) => {
        const value = message as unknown as { message?: unknown };
        return typeof value.message === 'string' && value.message.trim().length > 0;
      })
      .map((message) => {
        const value = message as unknown as {
          id?: number;
          date?: unknown;
          message?: string;
          views?: number;
          forwards?: number;
          fromId?: { userId?: { toString?: () => string } };
        };

        return {
          id: Number(value.id || 0),
          date: toIsoDate(value.date),
          text: String(value.message || ''),
          views: Number(value.views || 0),
          forwards: Number(value.forwards || 0),
          sender: value.fromId?.userId?.toString?.() || 'channel',
          channel: resolved.channelTitle,
          channelId: resolved.channelId,
        };
      });
  }

  async searchChannels(channelRefs: string[], keywords: string[], limit = 10) {
    await this.connect();

    const normalizedKeywords = uniqueStrings(keywords).map((keyword) => keyword.toLowerCase());
    if (!normalizedKeywords.length) {
      throw new Error('Keyword listesi bos olamaz.');
    }

    const normalizedChannels = uniqueStrings(channelRefs);
    const searchChannels = normalizedChannels.length ? normalizedChannels : this.getTrackedChannels();
    if (!searchChannels.length) {
      throw new Error('Arama icin kanal listesi bulunamadi.');
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    const results: Array<{
      channel: string;
      channelId: string;
      id: number;
      date: string | null;
      text: string;
      views: number;
    }> = [];

    for (const channelRef of searchChannels) {
      const resolved = await this.resolveChannelEntity(channelRef);

      if (!this.client) {
        throw new Error('Telegram client olusturulamadi.');
      }

      const messages = await this.client.getMessages(resolved.entity as never, { limit: 50 });
      const matched = messages
        .filter((message) => {
          const value = message as unknown as { message?: unknown };
          if (typeof value.message !== 'string') {
            return false;
          }

          const text = value.message.toLowerCase();
          return normalizedKeywords.some((keyword) => text.includes(keyword));
        })
        .slice(0, safeLimit)
        .map((message) => {
          const value = message as unknown as {
            id?: number;
            date?: unknown;
            message?: string;
            views?: number;
          };

          return {
            channel: resolved.channelTitle,
            channelId: resolved.channelId,
            id: Number(value.id || 0),
            date: toIsoDate(value.date),
            text: String(value.message || ''),
            views: Number(value.views || 0),
          };
        });

      results.push(...matched);
    }

    return results
      .sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')))
      .slice(0, safeLimit * searchChannels.length);
  }
}