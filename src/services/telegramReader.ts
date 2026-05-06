import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { env } from '../config/env.js';
import { AppConfigStore } from './appConfigStore.js';
import { TelegramSourceStore } from './telegramSourceStore.js';

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

interface ScanMessagesOptions {
  hoursBack: number;
  limitPerChannel?: number;
}

interface ScannedChannelMessage {
  id: number;
  date: string | null;
  text: string;
  views: number;
  forwards: number;
  sender: string;
  channel: string;
  channelId: string;
  channelRef: string;
}

interface ReaderStatus {
  configured: boolean;
  authenticated: boolean;
  connected: boolean;
  hasSession: boolean;
  pendingCode: boolean;
  sourceChannels: string[];
  sourceChannelSource: 'none' | 'env' | 'supabase' | 'memory';
  sessionSource: 'none' | 'env' | 'supabase' | 'memory';
  sessionPreview: string | null;
  phoneNumberConfigured: boolean;
  phoneNumberPreview: string | null;
  persistence: {
    configured: boolean;
    target: 'supabase.app_config' | 'memory';
    key: string | null;
    lastPersistedAt: string | null;
    lastError: string | null;
  };
  liveCheck: {
    status: 'idle' | 'ok' | 'failed';
    checkedAt: string | null;
    message: string | null;
    sampleCount: number | null;
  };
  reason: string | null;
}

interface SessionPersistenceResult {
  persisted: boolean;
  target: 'supabase.app_config' | 'memory';
  key: string | null;
  updatedAt: string | null;
  error?: string;
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

const TELEGRAM_SESSION_CONFIG_KEY = 'telegram_session_string';

const maskSessionString = (value: string) => {
  const safeValue = String(value || '').trim();
  if (!safeValue) {
    return null;
  }

  if (safeValue.length <= 14) {
    return `${safeValue.slice(0, 4)}...${safeValue.slice(-4)}`;
  }

  return `${safeValue.slice(0, 8)}...${safeValue.slice(-8)}`;
};

const maskPhoneNumber = (value: string) => {
  const safeValue = String(value || '').trim();
  if (!safeValue) {
    return null;
  }

  if (safeValue.length <= 6) {
    return `${safeValue.slice(0, 2)}...${safeValue.slice(-2)}`;
  }

  return `${safeValue.slice(0, 5)}...${safeValue.slice(-2)}`;
};

export class TelegramReader {
  private client: InternalTelegramClient | null = null;
  private authClient: InternalTelegramClient | null = null;
  private readonly appConfigStore = new AppConfigStore();
  private readonly telegramSourceStore = new TelegramSourceStore();
  private apiId: number | null = env.TELEGRAM_API_ID ? Number(env.TELEGRAM_API_ID) : null;
  private apiHash: string | null = env.TELEGRAM_API_HASH || null;
  private sessionString: string = env.TELEGRAM_SESSION_STRING || '';
  private sourceChannels: string[] = [...env.TELEGRAM_SOURCE_CHANNELS];
  private phoneCodeHash: string | null = null;
  private lastPhoneNumber: string | null = env.TELEGRAM_PHONE_NUMBER || null;
  private connected = false;
  private authConnected = false;
  private sourceChannelSource: 'none' | 'env' | 'supabase' | 'memory' = this.sourceChannels.length ? 'env' : 'none';
  private sessionSource: 'none' | 'env' | 'supabase' | 'memory' = this.sessionString ? 'env' : 'none';
  private lastPersistedAt: string | null = null;
  private lastPersistenceError: string | null = null;
  private lastAuthError: string | null = null;
  private lastLiveCheckStatus: 'idle' | 'ok' | 'failed' = 'idle';
  private lastLiveCheckAt: string | null = null;
  private lastLiveCheckMessage: string | null = null;
  private lastLiveCheckSampleCount: number | null = null;

  private setLiveCheck(status: 'idle' | 'ok' | 'failed', message: string | null, sampleCount: number | null = null) {
    this.lastLiveCheckStatus = status;
    this.lastLiveCheckAt = new Date().toISOString();
    this.lastLiveCheckMessage = message;
    this.lastLiveCheckSampleCount = sampleCount;
  }

  private resetLiveCheck() {
    this.lastLiveCheckStatus = 'idle';
    this.lastLiveCheckAt = null;
    this.lastLiveCheckMessage = null;
    this.lastLiveCheckSampleCount = null;
  }

  private isSessionRevokedError(message: string) {
    return /(SESSION_REVOKED|AUTH_KEY_UNREGISTERED|SESSION_EXPIRED)/i.test(message);
  }

  private async invalidateSession(reason: string) {
    this.sessionString = '';
    this.sessionSource = 'none';
    this.phoneCodeHash = null;
    this.lastAuthError = reason;
    this.setLiveCheck('failed', reason, 0);
    this.resetClient();
    this.resetAuthClient();

    if (!this.appConfigStore.isConfigured()) {
      return;
    }

    try {
      const entry = await this.appConfigStore.setValue(TELEGRAM_SESSION_CONFIG_KEY, '');
      this.lastPersistedAt = entry.updatedAt;
      this.lastPersistenceError = null;
    } catch (error) {
      this.lastPersistenceError = formatError(error);
    }
  }

  private ensureConfigured() {
    if (!this.apiId || !this.apiHash) {
      throw new Error('Telegram API ID ve API Hash ayarlanmamis.');
    }
  }

  private createClient(sessionString = this.sessionString) {
    this.ensureConfigured();

    return new TelegramClient(
      new StringSession(sessionString || ''),
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

  private resetAuthClient() {
    if (this.authClient) {
      void this.authClient.disconnect().catch(() => undefined);
    }

    this.authClient = null;
    this.authConnected = false;
  }

  async disconnect() {
    if (this.client && this.connected) {
      await this.client.disconnect();
      this.connected = false;
    }

    if (this.authClient && this.authConnected) {
      await this.authClient.disconnect();
      this.authConnected = false;
    }
  }

  async initialize() {
    const [storedSession] = await Promise.all([
      this.loadPersistedSession(),
      this.loadTrackedChannels(),
    ]);

    if (storedSession) {
      this.resetClient();
      this.resetAuthClient();
    }

    return this.getStatus();
  }

  private async loadTrackedChannels() {
    if (!this.telegramSourceStore.isConfigured()) {
      return false;
    }

    try {
      const channelRefs = await this.telegramSourceStore.listEnabledChannelRefs();
      if (!channelRefs.length) {
        return false;
      }

      this.sourceChannels = uniqueStrings(channelRefs);
      this.sourceChannelSource = 'supabase';
      return true;
    } catch {
      return false;
    }
  }

  private async syncTrackedChannels() {
    if (!this.telegramSourceStore.isConfigured()) {
      return false;
    }

    await this.telegramSourceStore.syncChannelRefs(this.sourceChannels);
    this.sourceChannelSource = this.sourceChannels.length ? 'supabase' : 'none';
    return true;
  }

  private async loadPersistedSession() {
    if (!this.appConfigStore.isConfigured()) {
      return false;
    }

    try {
      const entry = await this.appConfigStore.getValue(TELEGRAM_SESSION_CONFIG_KEY);
      if (!entry?.value || entry.value.length < 10) {
        return false;
      }

      this.sessionString = entry.value;
      this.sessionSource = 'supabase';
      this.lastPersistedAt = entry.updatedAt;
      this.lastPersistenceError = null;
      this.lastAuthError = null;
      return true;
    } catch (error) {
      this.lastPersistenceError = formatError(error);
      return false;
    }
  }

  private async persistSession(): Promise<SessionPersistenceResult> {
    const sessionString = this.getSessionString();
    if (!sessionString || sessionString.length < 10) {
      return {
        persisted: false,
        target: this.appConfigStore.isConfigured() ? 'supabase.app_config' : 'memory',
        key: this.appConfigStore.isConfigured() ? TELEGRAM_SESSION_CONFIG_KEY : null,
        updatedAt: null,
        error: 'Gecerli Telegram session bulunamadi.',
      };
    }

    if (!this.appConfigStore.isConfigured()) {
      this.sessionSource = 'memory';
      this.lastPersistenceError = 'Supabase app_config persistence not configured.';
      return {
        persisted: false,
        target: 'memory',
        key: null,
        updatedAt: null,
        error: this.lastPersistenceError,
      };
    }

    try {
      const entry = await this.appConfigStore.setValue(TELEGRAM_SESSION_CONFIG_KEY, sessionString);
      this.sessionSource = 'supabase';
      this.lastPersistedAt = entry.updatedAt;
      this.lastPersistenceError = null;

      return {
        persisted: true,
        target: 'supabase.app_config',
        key: entry.key,
        updatedAt: entry.updatedAt,
      };
    } catch (error) {
      this.sessionSource = 'memory';
      this.lastPersistenceError = formatError(error);
      return {
        persisted: false,
        target: 'supabase.app_config',
        key: TELEGRAM_SESSION_CONFIG_KEY,
        updatedAt: null,
        error: this.lastPersistenceError,
      };
    }
  }

  async configure(input: ConfigureReaderInput) {
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
      this.sessionSource = this.sessionString ? 'memory' : 'none';
      this.lastAuthError = null;
      this.resetLiveCheck();
    }

    if (Array.isArray(input.sourceChannels)) {
      this.sourceChannels = uniqueStrings(input.sourceChannels);
      this.sourceChannelSource = this.sourceChannels.length ? 'memory' : 'none';
      await this.syncTrackedChannels();
    }

    this.resetClient();
    this.resetAuthClient();
    return this.getStatus();
  }

  async resetSession() {
    this.sessionString = '';
    this.sessionSource = 'none';
    this.phoneCodeHash = null;
    this.lastAuthError = 'Telegram session sifirlandi. Tekrar kod isteyebilirsiniz.';
    this.resetClient();
    this.resetAuthClient();
    this.setLiveCheck('idle', this.lastAuthError, null);

    if (this.appConfigStore.isConfigured()) {
      try {
        const entry = await this.appConfigStore.setValue(TELEGRAM_SESSION_CONFIG_KEY, '');
        this.lastPersistedAt = entry.updatedAt;
        this.lastPersistenceError = null;
      } catch (error) {
        this.lastPersistenceError = formatError(error);
      }
    }

    return this.getStatus();
  }

  async testConnection(limit = 10) {
    const channels = await this.getJoinedChannels(limit);

    return {
      checkedAt: this.lastLiveCheckAt,
      channelCount: channels.length,
      sampleChannels: channels.slice(0, 5),
      status: this.getStatus(),
    };
  }

  getStatus(): ReaderStatus {
    const configured = Boolean(this.apiId && this.apiHash);
    const hasSession = Boolean(this.sessionString && this.sessionString.length > 10);
    const phoneNumber = String(this.lastPhoneNumber || env.TELEGRAM_PHONE_NUMBER || '').trim();

    return {
      configured,
      authenticated: hasSession,
      connected: this.connected,
      hasSession,
      pendingCode: Boolean(this.phoneCodeHash),
      sourceChannels: [...this.sourceChannels],
      sourceChannelSource: this.sourceChannels.length ? this.sourceChannelSource : 'none',
      sessionSource: hasSession ? this.sessionSource : 'none',
      sessionPreview: hasSession ? maskSessionString(this.sessionString) : null,
      phoneNumberConfigured: Boolean(phoneNumber),
      phoneNumberPreview: maskPhoneNumber(phoneNumber),
      persistence: {
        configured: this.appConfigStore.isConfigured(),
        target: this.appConfigStore.isConfigured() ? 'supabase.app_config' : 'memory',
        key: this.appConfigStore.isConfigured() ? TELEGRAM_SESSION_CONFIG_KEY : null,
        lastPersistedAt: this.lastPersistedAt,
        lastError: this.lastPersistenceError,
      },
      liveCheck: {
        status: this.lastLiveCheckStatus,
        checkedAt: this.lastLiveCheckAt,
        message: this.lastLiveCheckMessage,
        sampleCount: this.lastLiveCheckSampleCount,
      },
      reason: this.lastAuthError,
    };
  }

  getSessionString() {
    if (this.authClient) {
      const latestAuth = String((this.authClient.session as unknown as StringSession).save() || '');
      if (latestAuth) {
        this.sessionString = latestAuth;
        return this.sessionString;
      }
    }

    if (this.client) {
      const latest = String((this.client.session as unknown as StringSession).save() || '');
      if (latest) {
        this.sessionString = latest;
      }
    }

    return this.sessionString;
  }

  getSessionInfo() {
    const sessionString = this.getSessionString();
    return {
      sessionString,
      sessionPreview: maskSessionString(sessionString),
      sessionSource: sessionString ? this.sessionSource : 'none',
      persistence: this.getStatus().persistence,
    };
  }

  async persistCurrentSession() {
    return this.persistSession();
  }

  async connect() {
    try {
      this.ensureConfigured();

      if (!this.client) {
        this.client = this.createClient();
      }

      if (!this.connected) {
        await this.client.connect();
        this.connected = true;
        this.lastAuthError = null;
      }
    } catch (error) {
      const message = formatError(error);
      if (this.isSessionRevokedError(message)) {
        await this.invalidateSession('Telegram session gecersiz veya revoke edildi. Yeniden OTP ile giris yapin.');
      } else {
        this.lastAuthError = message;
        this.setLiveCheck('failed', message, 0);
      }

      throw new Error(this.lastAuthError || message);
    }
  }

  private async connectAuthClient() {
    this.ensureConfigured();

    if (!this.authClient) {
      this.authClient = this.createClient('');
    }

    if (!this.authConnected) {
      await this.authClient.connect();
      this.authConnected = true;
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

    this.resetAuthClient();
    await this.connectAuthClient();

    if (!this.authClient) {
      throw new Error('Telegram client olusturulamadi.');
    }

    const result = await this.authClient.sendCode(
      {
        apiId: this.apiId as number,
        apiHash: this.apiHash as string,
      },
      phone,
      forceSMS,
    );

    this.lastPhoneNumber = phone;
    this.phoneCodeHash = String(result.phoneCodeHash || '');
    this.lastAuthError = null;
    const isCodeViaApp = Boolean((result as { isCodeViaApp?: boolean }).isCodeViaApp);

    return {
      phoneCodeHash: this.phoneCodeHash,
      phoneNumber: phone,
      isCodeViaApp,
      forceSmsRequested: Boolean(forceSMS),
    };
  }

  async verifyCode(code: string, phoneNumber?: string, phoneCodeHash?: string) {
    await this.connectAuthClient();

    if (!this.authClient) {
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
      await this.authClient.invoke(
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

    this.sessionString = String((this.authClient.session as unknown as StringSession).save() || '');
    this.sessionSource = 'memory';
    this.phoneCodeHash = null;
    this.lastAuthError = null;
    this.resetLiveCheck();
    const persistence = await this.persistSession();
    this.resetClient();
    this.resetAuthClient();

    return {
      status: 'ok' as const,
      message: 'Telegram girisi basarili.',
      sessionString: this.sessionString,
      persistence,
    };
  }

  async verify2FA(password?: string) {
    await this.connectAuthClient();

    if (!this.authClient) {
      throw new Error('Telegram client olusturulamadi.');
    }

    const effectivePassword = String(password || env.TELEGRAM_2FA_PASSWORD || '').trim();
    if (!effectivePassword) {
      throw new Error('2FA sifresi gerekli.');
    }

    const passwordInfo = await this.authClient.invoke(new Api.account.GetPassword());
    const computed = await (this.authClient._computeCheck?.(passwordInfo, effectivePassword));

    if (!computed) {
      throw new Error('2FA sifresi dogrulanamadi.');
    }

    await this.authClient.invoke(
      new Api.auth.CheckPassword({
        password: computed as unknown as Api.TypeInputCheckPasswordSRP,
      }),
    );

    this.sessionString = String((this.authClient.session as unknown as StringSession).save() || '');
    this.sessionSource = 'memory';
    this.lastAuthError = null;
    this.resetLiveCheck();
    const persistence = await this.persistSession();
    this.resetClient();
    this.resetAuthClient();

    return {
      status: 'ok' as const,
      message: '2FA dogrulamasi basarili.',
      sessionString: this.sessionString,
      persistence,
    };
  }

  getTrackedChannels() {
    return [...this.sourceChannels];
  }

  setTrackedChannels(channels: string[]) {
    this.sourceChannels = uniqueStrings(channels);
    this.sourceChannelSource = this.sourceChannels.length ? 'memory' : 'none';
    return this.getTrackedChannels();
  }

  async getJoinedChannels(limit = 200) {
    await this.connect();

    if (!this.client) {
      throw new Error('Telegram client olusturulamadi.');
    }

    let dialogs;
    try {
      dialogs = await this.client.getDialogs({
        limit: Math.max(1, Math.min(Number(limit) || 200, 500)),
      });
      this.lastAuthError = null;
      this.setLiveCheck('ok', `${dialogs.length} kanal listesi alindi.`, dialogs.length);
    } catch (error) {
      const message = formatError(error);
      if (this.isSessionRevokedError(message)) {
        await this.invalidateSession('Telegram session gecersiz veya revoke edildi. Yeniden OTP ile giris yapin.');
      } else {
        this.lastAuthError = message;
        this.setLiveCheck('failed', message, 0);
      }

      throw new Error(this.lastAuthError || message);
    }

    const channels = dialogs
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

    this.setLiveCheck('ok', `${channels.length} kanal listesi alindi.`, channels.length);

    return channels;
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

  async scanRecentMessages(channelRefs: string[], options: ScanMessagesOptions) {
    await this.connect();

    if (!this.client) {
      throw new Error('Telegram client olusturulamadi.');
    }

    const normalizedChannels = uniqueStrings(channelRefs);
    if (!normalizedChannels.length) {
      throw new Error('Taranacak kanal listesi bos olamaz.');
    }

    const hoursBack = Math.max(1, Math.min(Number(options.hoursBack) || 24, 24 * 30));
    const limitPerChannel = Math.max(10, Math.min(Number(options.limitPerChannel) || 80, 250));
    const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);
    const batchSize = Math.min(50, limitPerChannel);
    const results: ScannedChannelMessage[] = [];

    for (const channelRef of normalizedChannels) {
      const resolved = await this.resolveChannelEntity(channelRef);
      let offsetId = 0;
      let collectedForChannel = 0;
      let continueScanning = true;

      while (continueScanning && collectedForChannel < limitPerChannel) {
        const remaining = limitPerChannel - collectedForChannel;
        const messages = await this.client.getMessages(resolved.entity as never, {
          limit: Math.min(batchSize, remaining),
          offsetId: offsetId || undefined,
        });

        if (!messages.length) {
          break;
        }

        let nextOffsetId = offsetId;

        for (const message of messages) {
          const value = message as unknown as {
            id?: number;
            date?: unknown;
            message?: string;
            views?: number;
            forwards?: number;
            fromId?: { userId?: { toString?: () => string } };
          };

          const messageId = Number(value.id || 0);
          const messageText = String(value.message || '').trim();
          const messageDate = toIsoDate(value.date);
          nextOffsetId = messageId || nextOffsetId;

          if (!messageId || !messageText) {
            continue;
          }

          if (messageDate) {
            const timestamp = new Date(messageDate).getTime();
            if (Number.isFinite(timestamp) && timestamp < cutoffTime) {
              continueScanning = false;
              continue;
            }
          }

          results.push({
            id: messageId,
            date: messageDate,
            text: messageText,
            views: Number(value.views || 0),
            forwards: Number(value.forwards || 0),
            sender: value.fromId?.userId?.toString?.() || 'channel',
            channel: resolved.channelTitle,
            channelId: resolved.channelId,
            channelRef,
          });
          collectedForChannel += 1;

          if (collectedForChannel >= limitPerChannel) {
            continueScanning = false;
            break;
          }
        }

        if (!nextOffsetId || nextOffsetId === offsetId) {
          break;
        }

        offsetId = nextOffsetId;
      }
    }

    return results.sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')));
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