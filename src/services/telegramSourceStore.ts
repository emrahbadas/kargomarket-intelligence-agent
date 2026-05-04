import { env } from '../config/env.js';

interface TelegramSourceRow {
  channel_ref: string;
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

export class TelegramSourceStore {
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

  async listEnabledChannelRefs(): Promise<string[]> {
    if (!this.isConfigured()) {
      return [];
    }

    const query = new URLSearchParams({
      select: 'channel_ref',
      enabled: 'eq.true',
      order: 'priority.asc,channel_ref.asc',
    });

    const response = await fetch(`${this.baseUrl}/rest/v1/telegram_sources?${query.toString()}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    const rows = await response.json() as TelegramSourceRow[];
    return rows.map((row) => String(row.channel_ref || '').trim()).filter(Boolean);
  }

  async syncChannelRefs(channelRefs: string[]) {
    if (!this.isConfigured()) {
      return { persisted: false, count: 0 };
    }

    const normalized = [...new Set(channelRefs.map((value) => String(value || '').trim()).filter(Boolean))];
    const existing = await this.listAllChannelRefs();

    if (normalized.length) {
      const response = await fetch(`${this.baseUrl}/rest/v1/telegram_sources?on_conflict=channel_ref`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(true),
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(
          normalized.map((channelRef, index) => ({
            channel_ref: channelRef,
            enabled: true,
            priority: index + 1,
          })),
        ),
      });

      if (!response.ok) {
        throw new Error(await toErrorMessage(response));
      }
    }

    for (const channelRef of existing.filter((value) => !normalized.includes(value))) {
      const response = await fetch(`${this.baseUrl}/rest/v1/telegram_sources?channel_ref=eq.${encodeURIComponent(channelRef)}`, {
        method: 'PATCH',
        headers: {
          ...this.getHeaders(true),
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ enabled: false }),
      });

      if (!response.ok) {
        throw new Error(await toErrorMessage(response));
      }
    }

    return { persisted: true, count: normalized.length };
  }

  private async listAllChannelRefs() {
    const query = new URLSearchParams({
      select: 'channel_ref',
      order: 'channel_ref.asc',
    });

    const response = await fetch(`${this.baseUrl}/rest/v1/telegram_sources?${query.toString()}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    const rows = await response.json() as TelegramSourceRow[];
    return rows.map((row) => String(row.channel_ref || '').trim()).filter(Boolean);
  }
}