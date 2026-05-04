import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { reviewStatusValues } from '../domain/types.js';
import { PipelineService } from '../services/pipeline.js';
import { TelegramReader } from '../services/telegramReader.js';

const manualIngestSchema = z.object({
  sourceName: z.string().min(2),
  title: z.string().min(4),
  rawText: z.string().min(12),
  sourceUrl: z.string().url().optional(),
});

const reviewUpdateSchema = z.object({
  status: z.enum(reviewStatusValues),
  reviewerNotes: z.string().max(500).optional(),
});

const telegramConfigureSchema = z.object({
  apiId: z.union([z.string(), z.number()]).optional(),
  apiHash: z.string().min(8).optional(),
  sessionString: z.string().optional(),
  sourceChannels: z.array(z.string().min(1)).optional(),
});

const telegramSendCodeSchema = z.object({
  phoneNumber: z.string().min(5).optional(),
  forceSms: z.boolean().optional(),
});

const telegramVerifyCodeSchema = z.object({
  phoneNumber: z.string().min(5).optional(),
  code: z.string().min(2),
  phoneCodeHash: z.string().optional(),
});

const telegramVerify2FASchema = z.object({
  password: z.string().min(1).optional(),
});

const telegramReadMessagesSchema = z.object({
  channelRef: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
});

const telegramSearchSchema = z.object({
  channelRefs: z.array(z.string().min(1)).optional(),
  keywords: z.array(z.string().min(1)),
  limit: z.number().int().positive().max(50).optional(),
});

const telegramChannelQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const toErrorMessage = (error: unknown) => {
  if (error && typeof error === 'object') {
    const maybeError = error as { message?: string; errorMessage?: string };
    return maybeError.errorMessage || maybeError.message || 'Unknown error';
  }

  return String(error || 'Unknown error');
};

const ensureWriteAccess = async (request: FastifyRequest, reply: FastifyReply) => {
  if (!env.AGENT_API_TOKEN) {
    return true;
  }

  const token = request.headers['x-agent-token'];
  if (token === env.AGENT_API_TOKEN) {
    return true;
  }

  await reply.code(401).send({ error: 'Unauthorized' });
  return false;
};

export const registerRoutes = async (app: FastifyInstance, pipeline: PipelineService, telegramReader: TelegramReader) => {
  app.get('/health', async () => ({
    service: 'kargomarket-intelligence-agent',
    status: 'ok',
    timestamp: new Date().toISOString(),
    stats: pipeline.getStats(),
  }));

  app.get('/health/dependencies', async () => {
    const dependencies = pipeline.getDependencyHealth();
    const telegramStatus = telegramReader.getStatus();

    if (telegramStatus.configured && telegramStatus.authenticated) {
      dependencies.telegramUser = 'configured';
    }

    return {
      service: 'kargomarket-intelligence-agent',
      timestamp: new Date().toISOString(),
      dependencies,
      telegram: telegramStatus,
    };
  });

  app.get('/v1/sources', async () => ({
    items: pipeline.listSources(),
  }));

  app.get('/v1/review-queue', async () => ({
    items: pipeline.listReviewQueue(),
  }));

  app.post('/v1/ingest/manual', async (request, reply) => {
    if (!(await ensureWriteAccess(request, reply))) {
      return reply;
    }

    const parsedBody = manualIngestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: 'Invalid payload',
        details: parsedBody.error.flatten(),
      });
    }

    const created = await pipeline.submitManualIngest(parsedBody.data);
    return reply.code(201).send(created);
  });

  app.post('/v1/review-queue/:id/status', async (request, reply) => {
    if (!(await ensureWriteAccess(request, reply))) {
      return reply;
    }

    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = reviewUpdateSchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: 'Invalid payload',
        details: {
          params: params.success ? null : params.error.flatten(),
          body: body.success ? null : body.error.flatten(),
        },
      });
    }

    const updated = pipeline.updateReviewStatus(params.data.id, body.data.status, body.data.reviewerNotes);
    if (!updated) {
      return reply.code(404).send({ error: 'Review item not found' });
    }

    return reply.send(updated);
  });

  app.get('/v1/telegram/status', async (_request, reply) => {
    if (!(await ensureWriteAccess(_request, reply))) {
      return reply;
    }

    return {
      status: 'ok',
      data: telegramReader.getStatus(),
    };
  });

  app.post('/v1/telegram/configure', async (request, reply) => {
    if (!(await ensureWriteAccess(request, reply))) {
      return reply;
    }

    const parsedBody = telegramConfigureSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: 'Invalid payload',
        details: parsedBody.error.flatten(),
      });
    }

    try {
      const status = await telegramReader.configure(parsedBody.data);
      return reply.send({ status: 'ok', data: status });
    } catch (error) {
      return reply.code(400).send({ status: 'error', error: toErrorMessage(error) });
    }
  });

  app.post('/v1/telegram/send-code', async (request, reply) => {
    if (!(await ensureWriteAccess(request, reply))) {
      return reply;
    }

    const parsedBody = telegramSendCodeSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: 'Invalid payload',
        details: parsedBody.error.flatten(),
      });
    }

    try {
      const result = await telegramReader.sendCode(
        parsedBody.data.phoneNumber,
        Boolean(parsedBody.data.forceSms),
      );
      return reply.send({ status: 'ok', data: result });
    } catch (error) {
      return reply.code(400).send({ status: 'error', error: toErrorMessage(error) });
    }
  });

  app.post('/v1/telegram/verify-code', async (request, reply) => {
    if (!(await ensureWriteAccess(request, reply))) {
      return reply;
    }

    const parsedBody = telegramVerifyCodeSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: 'Invalid payload',
        details: parsedBody.error.flatten(),
      });
    }

    try {
      const result = await telegramReader.verifyCode(
        parsedBody.data.code,
        parsedBody.data.phoneNumber,
        parsedBody.data.phoneCodeHash,
      );
      return reply.send({ status: 'ok', data: result });
    } catch (error) {
      return reply.code(400).send({ status: 'error', error: toErrorMessage(error) });
    }
  });

  app.post('/v1/telegram/verify-2fa', async (request, reply) => {
    if (!(await ensureWriteAccess(request, reply))) {
      return reply;
    }

    const parsedBody = telegramVerify2FASchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: 'Invalid payload',
        details: parsedBody.error.flatten(),
      });
    }

    try {
      const result = await telegramReader.verify2FA(parsedBody.data.password);
      return reply.send({ status: 'ok', data: result });
    } catch (error) {
      return reply.code(400).send({ status: 'error', error: toErrorMessage(error) });
    }
  });

  app.post('/v1/telegram/persist-session', async (request, reply) => {
    if (!(await ensureWriteAccess(request, reply))) {
      return reply;
    }

    const session = telegramReader.getSessionInfo();
    if (!session.sessionString || session.sessionString.length < 10) {
      return reply.code(400).send({
        status: 'error',
        error: 'Kalici kayit icin gecerli Telegram session bulunamadi.',
      });
    }

    const result = await telegramReader.persistCurrentSession();
    return reply.send({
      status: result.persisted ? 'ok' : 'warning',
      data: {
        ...result,
        sessionPreview: session.sessionPreview,
      },
    });
  });

  app.get('/v1/telegram/session', async (request, reply) => {
    if (!(await ensureWriteAccess(request, reply))) {
      return reply;
    }

    const session = telegramReader.getSessionInfo();
    if (!session.sessionString || session.sessionString.length < 10) {
      return reply.code(404).send({
        status: 'error',
        error: 'Aktif Telegram session bulunamadi.',
      });
    }

    return reply.send({ status: 'ok', data: session });
  });

  app.get('/v1/telegram/channels', async (request, reply) => {
    if (!(await ensureWriteAccess(request, reply))) {
      return reply;
    }

    const parsedQuery = telegramChannelQuerySchema.safeParse(request.query || {});
    if (!parsedQuery.success) {
      return reply.code(400).send({
        error: 'Invalid query',
        details: parsedQuery.error.flatten(),
      });
    }

    try {
      const channels = await telegramReader.getJoinedChannels(parsedQuery.data.limit || 200);
      return reply.send({ status: 'ok', data: channels });
    } catch (error) {
      return reply.code(400).send({ status: 'error', error: toErrorMessage(error), data: [] });
    }
  });

  app.post('/v1/telegram/read-messages', async (request, reply) => {
    if (!(await ensureWriteAccess(request, reply))) {
      return reply;
    }

    const parsedBody = telegramReadMessagesSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: 'Invalid payload',
        details: parsedBody.error.flatten(),
      });
    }

    try {
      const messages = await telegramReader.readChannelMessages(parsedBody.data.channelRef, parsedBody.data.limit || 20);
      return reply.send({ status: 'ok', data: messages });
    } catch (error) {
      return reply.code(400).send({ status: 'error', error: toErrorMessage(error), data: [] });
    }
  });

  app.post('/v1/telegram/search', async (request, reply) => {
    if (!(await ensureWriteAccess(request, reply))) {
      return reply;
    }

    const parsedBody = telegramSearchSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: 'Invalid payload',
        details: parsedBody.error.flatten(),
      });
    }

    try {
      const results = await telegramReader.searchChannels(
        parsedBody.data.channelRefs || [],
        parsedBody.data.keywords,
        parsedBody.data.limit || 10,
      );

      return reply.send({ status: 'ok', data: results });
    } catch (error) {
      return reply.code(400).send({ status: 'error', error: toErrorMessage(error), data: [] });
    }
  });
};