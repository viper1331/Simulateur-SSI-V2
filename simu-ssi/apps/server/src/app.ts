import express, { type Express } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { prisma } from './prisma';
import { DomainContext } from './state';
import { createServer, type Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

const siteConfigSchema = z.object({
  evacOnDMDelayMs: z.number().int().min(1000),
  processAckRequired: z.boolean(),
});

const manualEvacuationSchema = z.object({
  reason: z.string().optional(),
});

export function createHttpServer(domainContext: DomainContext): {
  app: Express;
  server: HttpServer;
  io: SocketIOServer;
} {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/config/site', async (_req, res) => {
    const config = await prisma.siteConfig.findUniqueOrThrow({ where: { id: 1 } });
    res.json({
      evacOnDAI: config.evacOnDAI,
      evacOnDMDelayMs: config.evacOnDMDelayMs,
      processAckRequired: config.processAckRequired,
    });
  });

  app.put('/api/config/site', async (req, res) => {
    const parsed = siteConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const config = await prisma.siteConfig.update({
      where: { id: 1 },
      data: parsed.data,
    });
    await domainContext.refreshConfig();
    res.json({
      evacOnDAI: config.evacOnDAI,
      evacOnDMDelayMs: config.evacOnDMDelayMs,
      processAckRequired: config.processAckRequired,
    });
  });

  app.post('/api/process/ack', async (req, res) => {
    const ackedBy = z.string().min(1).parse(req.body?.ackedBy ?? 'trainer');
    await prisma.processAck.update({
      where: { id: 1 },
      data: { isAcked: true, ackedBy, ackedAt: new Date(), clearedAt: null },
    });
    domainContext.domain.acknowledgeProcess(ackedBy);
    res.status(204).send();
  });

  app.post('/api/process/clear', async (_req, res) => {
    await prisma.processAck.update({
      where: { id: 1 },
      data: { isAcked: false, clearedAt: new Date(), ackedAt: null, ackedBy: null },
    });
    domainContext.domain.clearProcessAck();
    res.status(204).send();
  });

  app.post('/api/sdi/dm/:zone/activate', async (req, res) => {
    const zoneId = req.params.zone;
    await prisma.manualCallPoint.upsert({
      where: { id: await ensureManualZone(zoneId) },
      update: { isLatched: true, lastActivatedAt: new Date() },
      create: {
        zoneId,
        isLatched: true,
        lastActivatedAt: new Date(),
      },
    });
    domainContext.domain.activateDm(zoneId);
    res.status(202).json({ status: 'latched', zoneId });
  });

  app.post('/api/sdi/dm/:zone/reset', async (req, res) => {
    const zoneId = req.params.zone;
    const updated = await prisma.manualCallPoint.updateMany({
      where: { zoneId },
      data: { isLatched: false, lastResetAt: new Date() },
    });
    if (updated.count === 0) {
      return res.status(404).json({ error: 'ZONE_NOT_FOUND' });
    }
    domainContext.domain.resetDm(zoneId);
    res.status(200).json({ status: 'cleared', zoneId });
  });

  app.post('/api/evac/manual/start', async (req, res) => {
    const parsed = manualEvacuationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    domainContext.domain.startManualEvacuation(parsed.data.reason);
    await prisma.eventLog.create({
      data: {
        source: 'MANUAL',
        payloadJson: JSON.stringify({ reason: parsed.data.reason, action: 'start' }),
      },
    });
    res.status(202).json({ status: 'manual-evac-started' });
  });

  app.post('/api/evac/manual/stop', async (req, res) => {
    const parsed = manualEvacuationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    domainContext.domain.stopManualEvacuation(parsed.data.reason);
    await prisma.eventLog.create({
      data: {
        source: 'MANUAL',
        payloadJson: JSON.stringify({ reason: parsed.data.reason, action: 'stop' }),
      },
    });
    res.status(202).json({ status: 'manual-evac-stopped' });
  });

  app.post('/api/system/reset', async (_req, res) => {
    const result = domainContext.domain.trySystemReset();
    if (!result.ok) {
      return res.status(409).json({ error: result.reason });
    }
    await prisma.processAck.update({
      where: { id: 1 },
      data: { isAcked: false, ackedAt: null, ackedBy: null, clearedAt: new Date() },
    });
    res.status(200).json({ status: 'reset' });
  });

  app.get('/api/events', async (req, res) => {
    const { sessionId, from, to, limit } = req.query;
    const events = await prisma.eventLog.findMany({
      where: {
        sessionId: sessionId ? String(sessionId) : undefined,
        ts: {
          gte: from ? new Date(String(from)) : undefined,
          lte: to ? new Date(String(to)) : undefined,
        },
      },
      orderBy: { ts: 'desc' },
      take: limit ? Number(limit) : 100,
    });
    const normalizedEvents = events.map((event) => ({
      ...event,
      payloadJson: event.payloadJson ? JSON.parse(event.payloadJson) : null,
    }));
    res.json({ events: normalizedEvents });
  });

  app.get('/api/state', (_req, res) => {
    res.json(domainContext.snapshot());
  });

  const server = createServer(app);
  const io = new SocketIOServer(server, {
    cors: {
      origin: '*',
    },
  });

  domainContext.domain.emitter.on('state.update', (snapshot) => {
    io.emit('state.update', snapshot);
  });

  domainContext.domain.emitter.on('events.append', (event) => {
    io.emit('events.append', event);
  });

  return { app, server: server as HttpServer, io };
}

async function ensureManualZone(zoneId: string): Promise<number> {
  const existing = await prisma.manualCallPoint.findFirst({ where: { zoneId } });
  if (existing) {
    return existing.id;
  }
  const created = await prisma.manualCallPoint.create({
    data: { zoneId, isLatched: true, lastActivatedAt: new Date() },
  });
  return created.id;
}
