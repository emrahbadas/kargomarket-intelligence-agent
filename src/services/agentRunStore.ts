import { env } from '../config/env.js';

interface AgentRunRow {
  id: number;
  job_name: string;
  trigger_source: string;
  status: string;
  source_count: number;
  item_count: number;
  error_message?: string | null;
  metadata?: Record<string, unknown> | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface AgentRunRecord {
  id: number;
  jobName: string;
  triggerSource: string;
  status: string;
  sourceCount: number;
  itemCount: number;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  startedAt: string | null;
  finishedAt: string | null;
}

interface CreateRunInput {
  jobName: string;
  triggerSource: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'partial';
  sourceCount?: number;
  itemCount?: number;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}

interface FinishRunInput {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'partial';
  sourceCount?: number;
  itemCount?: number;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
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

const mapRow = (row: AgentRunRow): AgentRunRecord => ({
  id: Number(row.id),
  jobName: row.job_name,
  triggerSource: row.trigger_source,
  status: row.status,
  sourceCount: Number(row.source_count || 0),
  itemCount: Number(row.item_count || 0),
  errorMessage: row.error_message || null,
  metadata: (row.metadata as Record<string, unknown>) || {},
  startedAt: row.started_at || null,
  finishedAt: row.finished_at || null,
});

export class AgentRunStore {
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

  async createRun(input: CreateRunInput): Promise<AgentRunRecord | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const response = await fetch(`${this.baseUrl}/rest/v1/agent_ingestion_runs`, {
      method: 'POST',
      headers: {
        ...this.getHeaders(true),
        Prefer: 'return=representation',
      },
      body: JSON.stringify([{
        job_name: input.jobName,
        trigger_source: input.triggerSource,
        status: input.status,
        source_count: input.sourceCount || 0,
        item_count: input.itemCount || 0,
        error_message: input.errorMessage || null,
        metadata: input.metadata || {},
      }]),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    const rows = await response.json() as AgentRunRow[];
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async finishRun(runId: number, input: FinishRunInput): Promise<AgentRunRecord | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const response = await fetch(`${this.baseUrl}/rest/v1/agent_ingestion_runs?id=eq.${runId}`, {
      method: 'PATCH',
      headers: {
        ...this.getHeaders(true),
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        status: input.status,
        source_count: input.sourceCount,
        item_count: input.itemCount,
        error_message: input.errorMessage || null,
        metadata: input.metadata || {},
        finished_at: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      throw new Error(await toErrorMessage(response));
    }

    const rows = await response.json() as AgentRunRow[];
    return rows[0] ? mapRow(rows[0]) : null;
  }
}