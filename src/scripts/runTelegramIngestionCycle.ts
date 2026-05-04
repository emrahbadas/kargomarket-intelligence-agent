import { env } from '../config/env.js';
import { IngestionOrchestrator } from '../services/ingestionOrchestrator.js';
import { PipelineService } from '../services/pipeline.js';
import { TelegramReader } from '../services/telegramReader.js';

const parseChannelRefs = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }

  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length ? items : undefined;
};

const parseLimit = (value: string | undefined) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const main = async () => {
  const pipeline = new PipelineService();
  const telegramReader = new TelegramReader();
  const orchestrator = new IngestionOrchestrator(pipeline, telegramReader);

  const channelRefs = parseChannelRefs(process.env.INGESTION_CHANNEL_REFS);
  const limitPerChannel = parseLimit(process.env.INGESTION_LIMIT_PER_CHANNEL) ?? env.MAX_SOURCE_ITEMS_PER_RUN;
  const triggerSource = (process.env.INGESTION_TRIGGER_SOURCE || 'railway-scheduler').trim() || 'railway-scheduler';

  try {
    await telegramReader.initialize();

    const result = await orchestrator.runTelegramCycle({
      channelRefs,
      limitPerChannel,
      triggerSource,
    });

    console.log(JSON.stringify(result, null, 2));

    if (result.status !== 'succeeded') {
      process.exitCode = 1;
    }
  } finally {
    await telegramReader.disconnect();
  }
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  console.error(message);
  process.exit(1);
});