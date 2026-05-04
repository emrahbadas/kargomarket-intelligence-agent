import { PipelineService } from './pipeline.js';
import { TelegramReader } from './telegramReader.js';
import { AgentRunStore } from './agentRunStore.js';
import { TelegramCursorStore } from './telegramCursorStore.js';

interface RunCycleOptions {
  channelRefs?: string[];
  limitPerChannel?: number;
  triggerSource?: string;
}

interface ChannelRunResult {
  channelRef: string;
  fetched: number;
  ingested: number;
  status: 'ok' | 'error';
  error?: string;
  lastMessageId: number | null;
  lastMessageDate: string | null;
}

const uniqueStrings = (items: string[]) => {
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
};

const deriveTitle = (text: string, channelName: string) => {
  const firstLine = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return (firstLine || `${channelName} Telegram mesaji`).slice(0, 140);
};

const toErrorMessage = (error: unknown) => {
  if (error && typeof error === 'object') {
    const maybeError = error as { message?: string; errorMessage?: string };
    return maybeError.errorMessage || maybeError.message || 'Unknown error';
  }

  return String(error || 'Unknown error');
};

export class IngestionOrchestrator {
  constructor(
    private readonly pipeline: PipelineService,
    private readonly telegramReader: TelegramReader,
    private readonly agentRunStore = new AgentRunStore(),
    private readonly telegramCursorStore = new TelegramCursorStore(),
  ) {}

  async runTelegramCycle(options: RunCycleOptions = {}) {
    const trackedChannels = uniqueStrings(
      options.channelRefs?.length ? options.channelRefs : this.telegramReader.getTrackedChannels(),
    );

    if (!trackedChannels.length) {
      throw new Error('Calistirilacak Telegram kanali bulunamadi.');
    }

    const limitPerChannel = Math.max(1, Math.min(Number(options.limitPerChannel) || 20, 100));
    const triggerSource = String(options.triggerSource || 'manual').trim() || 'manual';

    const run = await this.agentRunStore.createRun({
      jobName: 'telegram_ingestion_cycle',
      triggerSource,
      status: 'running',
      sourceCount: trackedChannels.length,
      metadata: {
        channelRefs: trackedChannels,
        limitPerChannel,
      },
    });

    const channelResults: ChannelRunResult[] = [];
    let itemCount = 0;

    try {
      for (const channelRef of trackedChannels) {
        try {
          const cursor = await this.telegramCursorStore.getCursor(channelRef);
          const messages = await this.telegramReader.readChannelMessages(channelRef, limitPerChannel);
          const newMessages = messages
            .filter((message) => {
              const messageId = Number(message.id || 0);
              if (cursor?.lastMessageId && messageId <= cursor.lastMessageId) {
                return false;
              }

              if (!cursor?.lastMessageId && cursor?.lastMessageDate && message.date) {
                return String(message.date) > String(cursor.lastMessageDate);
              }

              return true;
            })
            .sort((left, right) => {
              const dateCompare = String(left.date || '').localeCompare(String(right.date || ''));
              return dateCompare !== 0 ? dateCompare : Number(left.id || 0) - Number(right.id || 0);
            });

          let ingested = 0;
          let lastMessageId: number | null = cursor?.lastMessageId ?? null;
          let lastMessageDate: string | null = cursor?.lastMessageDate ?? null;

          for (const message of newMessages) {
            await this.pipeline.submitManualIngest({
              sourceId: `telegram-${message.channelId}`,
              sourceName: `Telegram: ${message.channel}`,
              title: deriveTitle(message.text, message.channel),
              rawText: message.text,
              publishedAt: message.date || undefined,
            });

            ingested += 1;
            itemCount += 1;
            lastMessageId = Number(message.id || lastMessageId || 0) || lastMessageId;
            lastMessageDate = message.date || lastMessageDate;
          }

          if (ingested > 0 && lastMessageId) {
            await this.telegramCursorStore.upsertCursor({
              channelRef,
              lastMessageId,
              lastMessageDate,
            });
          }

          channelResults.push({
            channelRef,
            fetched: messages.length,
            ingested,
            status: 'ok',
            lastMessageId,
            lastMessageDate,
          });
        } catch (error) {
          channelResults.push({
            channelRef,
            fetched: 0,
            ingested: 0,
            status: 'error',
            error: toErrorMessage(error),
            lastMessageId: null,
            lastMessageDate: null,
          });
        }
      }

      const errorCount = channelResults.filter((result) => result.status === 'error').length;
      const finalStatus = errorCount === 0 ? 'succeeded' : itemCount > 0 ? 'partial' : 'failed';

      const finishedRun = run
        ? await this.agentRunStore.finishRun(run.id, {
          status: finalStatus,
          sourceCount: trackedChannels.length,
          itemCount,
          errorMessage: errorCount === 0 ? null : `${errorCount} kanal hata verdi.`,
          metadata: {
            channelResults,
            limitPerChannel,
          },
        })
        : null;

      return {
        runId: finishedRun?.id || run?.id || null,
        jobName: 'telegram_ingestion_cycle',
        triggerSource,
        status: finalStatus,
        sourceCount: trackedChannels.length,
        itemCount,
        channels: channelResults,
      };
    } catch (error) {
      if (run) {
        await this.agentRunStore.finishRun(run.id, {
          status: 'failed',
          sourceCount: trackedChannels.length,
          itemCount,
          errorMessage: toErrorMessage(error),
          metadata: {
            channelResults,
            limitPerChannel,
          },
        });
      }

      throw error;
    }
  }
}