import { env } from '../config/env.js';

interface AppConfigRow {
  key: string;
  value: string;
  updated_at?: string | null;
}

export interface AppConfigEntry {
  key: string;
  value: string;
  updatedAt: string | null;
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

export class AppConfigStore {
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

  async getValue(key: string): Promise<AppConfigEntry | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const query = new URLSearchParams({
      select: 'key,value,updated_at',
      key: `eq.${key}`,
      limit: '1',
    });

    const response = await fetch(`${this.baseUrl}/rest/v1/app_config?${query.toString()}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    const rows = await response.json() as AppConfigRow[];
    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      key: row.key,
      value: row.value,
      updatedAt: row.updated_at || null,
    };
  }

  async setValue(key: string, value: string): Promise<AppConfigEntry> {
    if (!this.isConfigured()) {
      throw new Error('Supabase app_config persistence not configured.');
    }

    const query = new URLSearchParams({
      on_conflict: 'key',
    });

    const response = await fetch(`${this.baseUrl}/rest/v1/app_config?${query.toString()}`, {
      method: 'POST',
      headers: {
        ...this.getHeaders(true),
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify([{ key, value }]),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    const rows = await response.json() as AppConfigRow[];
    const row = rows[0];

    return {
      key,
      value,
      updatedAt: row?.updated_at || new Date().toISOString(),
    };
  }
}