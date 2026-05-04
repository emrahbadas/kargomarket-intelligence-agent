import { env } from '../config/env.js';

interface CursorRow {
  channel_ref: string;
  last_message_id?: number | null;
  last_message_date?: string | null;
}

export interface TelegramChannelCursor {
  channelRef: string;
  lastMessageId: number | null;
  lastMessageDate: string | null;
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

export class TelegramCursorStore {
  private readonly baseUrl = env.SUPABASE_URL ? env.SUPABASE_URL.replace(/\/+$/, '') : '';
  private readonly serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
  private readonly schema = env.SUPABASE_SCHEMA || 'public';

  isConfigured() {
    return Boolean(this.baseUrl && this.serviceRoleKey);
  }

  private getHeaders(includeContentType = false) {
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

    return headers;
  }

  async getCursor(channelRef: string): Promise<TelegramChannelCursor | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const response = await fetch(`${this.baseUrl}/rest/v1/telegram_channel_cursors?select=channel_ref,last_message_id,last_message_date&channel_ref=eq.${encodeURIComponent(channelRef)}&limit=1`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    const rows = await response.json() as CursorRow[];
    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      channelRef: row.channel_ref,
      lastMessageId: row.last_message_id ?? null,
      lastMessageDate: row.last_message_date ?? null,
    };
  }

  async upsertCursor(cursor: TelegramChannelCursor) {
    if (!this.isConfigured()) {
      return null;
    }

    const response = await fetch(`${this.baseUrl}/rest/v1/telegram_channel_cursors?on_conflict=channel_ref`, {
      method: 'POST',
      headers: {
        ...this.getHeaders(true),
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify([{
        channel_ref: cursor.channelRef,
        last_message_id: cursor.lastMessageId,
        last_message_date: cursor.lastMessageDate,
      }]),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    return true;
  }
}