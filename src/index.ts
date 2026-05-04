import Fastify from 'fastify';
import { env } from './config/env.js';
import { registerRoutes } from './routes/index.js';
import { PipelineService } from './services/pipeline.js';
import { TelegramReader } from './services/telegramReader.js';

const start = async () => {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
    },
  });

  const pipeline = new PipelineService();
  const telegramReader = new TelegramReader();

  app.addHook('onClose', async () => {
    await telegramReader.disconnect();
  });

  await registerRoutes(app, pipeline, telegramReader);

  await app.listen({
    port: env.PORT,
    host: '0.0.0.0',
  });
};

start().catch((error) => {
  console.error(error);
  process.exit(1);
});