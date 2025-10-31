import express, { type Express } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma';
import { DomainContext } from './state';
import { createServer, type Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import {
  scenarioDefinitionSchema,
  scenarioPayloadSchema,
  scenarioRunnerSnapshotSchema,
  type ScenarioDefinition,
} from '@simu-ssi/sdk';
import { ScenarioRunner } from './scenario-runner';

const siteConfigSchema = z.object({
  evacOnDAI: z.boolean(),
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

  const scenarioRunner = new ScenarioRunner(domainContext.domain);

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

  app.post('/api/sdi/dai/:zone/activate', async (req, res) => {
    const zoneId = req.params.zone;
    domainContext.domain.activateDai(zoneId);
    res.status(202).json({ status: 'activated', zoneId });
  });

  app.post('/api/sdi/dai/:zone/reset', async (req, res) => {
    const zoneId = req.params.zone;
    domainContext.domain.resetDai(zoneId);
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

  app.get('/api/topology', async (_req, res) => {
    const [zones, devices] = await Promise.all([
      prisma.zone.findMany({ orderBy: { label: 'asc' } }),
      prisma.device.findMany({ orderBy: { id: 'asc' } }),
    ]);
    res.json({
      zones: zones.map((zone) => ({
        id: zone.id,
        label: zone.label,
        kind: zone.kind,
      })),
      devices: devices.map((device) => {
        const parsedProps = parseDeviceProps(device.propsJson);
        return {
          id: device.id,
          kind: device.kind,
          zoneId: device.zoneId ?? undefined,
          label: typeof parsedProps?.label === 'string' ? parsedProps.label : undefined,
          props: parsedProps ?? undefined,
        };
      }),
    });
  });

  app.get('/api/scenarios', async (_req, res) => {
    const records = await prisma.scenario.findMany({ orderBy: { name: 'asc' } });
    const scenarios = records.map(serializeScenarioRecord);
    res.json({ scenarios });
  });

  app.post('/api/scenarios', async (req, res) => {
    const parsed = scenarioPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const eventsWithIds = parsed.data.events.map((event) => ({
      ...event,
      id: event.id ?? randomUUID(),
    }));
    const record = await prisma.scenario.create({
      data: {
        id: randomUUID(),
        name: parsed.data.name,
        json: JSON.stringify({ description: parsed.data.description, events: eventsWithIds }),
      },
    });
    const scenario = scenarioDefinitionSchema.parse({
      id: record.id,
      name: record.name,
      description: parsed.data.description,
      events: eventsWithIds,
    });
    res.status(201).json({ scenario });
  });

  app.put('/api/scenarios/:id', async (req, res) => {
    const parsed = scenarioPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const eventsWithIds = parsed.data.events.map((event) => ({
      ...event,
      id: event.id ?? randomUUID(),
    }));
    const record = await prisma.scenario.update({
      where: { id: req.params.id },
      data: {
        name: parsed.data.name,
        json: JSON.stringify({ description: parsed.data.description, events: eventsWithIds }),
      },
    });
    const scenario = scenarioDefinitionSchema.parse({
      id: record.id,
      name: record.name,
      description: parsed.data.description,
      events: eventsWithIds,
    });
    res.json({ scenario });
  });

  app.delete('/api/scenarios/:id', async (req, res) => {
    await prisma.scenario.delete({ where: { id: req.params.id } });
    res.status(204).send();
  });

  app.post('/api/scenarios/:id/run', async (req, res) => {
    const record = await prisma.scenario.findUnique({ where: { id: req.params.id } });
    if (!record) {
      return res.status(404).json({ error: 'SCENARIO_NOT_FOUND' });
    }
    const scenario = serializeScenarioRecord(record);
    scenarioRunner.run(scenario);
    await prisma.eventLog.create({
      data: {
        source: 'TRAINER',
        payloadJson: JSON.stringify({ action: 'scenario-run', scenarioId: scenario.id }),
      },
    });
    res.json(scenarioRunnerSnapshotSchema.parse(scenarioRunner.state));
  });

  app.post('/api/scenarios/stop', async (_req, res) => {
    const previousScenario = scenarioRunner.state.scenario;
    scenarioRunner.stop(previousScenario ? 'stopped' : 'idle');
    if (previousScenario) {
      await prisma.eventLog.create({
        data: {
          source: 'TRAINER',
          payloadJson: JSON.stringify({ action: 'scenario-stop', scenarioId: previousScenario.id }),
        },
      });
    }
    res.json(scenarioRunnerSnapshotSchema.parse(scenarioRunner.state));
  });

  app.get('/api/scenarios/active', (_req, res) => {
    res.json(scenarioRunnerSnapshotSchema.parse(scenarioRunner.state));
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

  scenarioRunner.on('scenario.update', (snapshot) => {
    io.emit('scenario.update', snapshot);
  });

  io.on('connection', (socket) => {
    socket.emit('scenario.update', scenarioRunner.state);
  });

  return { app, server: server as HttpServer, io };
}

function parseDeviceProps(json: string | null): Record<string, unknown> | undefined {
  if (!json) {
    return undefined;
  }
  try {
    const value = JSON.parse(json);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch (error) {
    console.error('Failed to parse device props json', error);
    return undefined;
  }
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

function serializeScenarioRecord(record: { id: string; name: string; json: string }): ScenarioDefinition {
  let payload: { description?: string; events: unknown };
  try {
    payload = JSON.parse(record.json);
  } catch (error) {
    payload = { description: undefined, events: [] };
  }
  return scenarioDefinitionSchema.parse({
    id: record.id,
    name: record.name,
    description: payload.description,
    events: Array.isArray(payload.events) ? payload.events : [],
  });
}
