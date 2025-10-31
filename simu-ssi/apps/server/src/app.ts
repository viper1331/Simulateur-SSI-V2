import express, { type Express } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { DomainContext } from './state';
import { createServer, type Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import {
  DEFAULT_TRAINEE_LAYOUT,
  scenarioDefinitionSchema,
  scenarioPayloadSchema,
  scenarioRunnerSnapshotSchema,
  siteTopologySchema,
  traineeLayoutSchema,
  type ScenarioDefinition,
  type TraineeLayoutConfig,
} from '@simu-ssi/sdk';
import { ScenarioRunner } from './scenario-runner';
import { SessionManager } from './session-manager';
import { generateImprovementAreasForSession } from './improvement-generator';
import { createLogger, toError } from './logger';

const siteConfigSchema = z.object({
  evacOnDAI: z.boolean(),
  evacOnDMDelayMs: z.number().int().min(1000),
  processAckRequired: z.boolean(),
});

const manualEvacuationSchema = z.object({
  reason: z.string().optional(),
});

const accessCodeUpdateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(4)
    .max(8)
    .regex(/^[0-9]+$/, 'CODE_DIGITS_ONLY'),
});

const accessCodeVerifySchema = z.object({
  code: z.string().max(32),
});

const userRoleSchema = z.enum(['TRAINER', 'TRAINEE']);

const userCreateSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email().optional(),
  role: userRoleSchema.default('TRAINEE'),
});

const userUpdateSchema = z.object({
  fullName: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  role: userRoleSchema.optional(),
});

const improvementAreaSchema = z.object({
  title: z.string().min(1),
  description: z.string().max(1000).optional(),
});

const sessionCreateSchema = z.object({
  name: z.string().min(1),
  mode: z.string().min(1).default('libre'),
  traineeId: z.string().uuid().optional(),
  trainerId: z.string().uuid().optional(),
  objective: z.string().max(1000).optional(),
  notes: z.string().max(4000).optional(),
});

const sessionUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
  traineeId: z.string().uuid().nullable().optional(),
  trainerId: z.string().uuid().nullable().optional(),
  objective: z.string().max(1000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

const sessionCloseSchema = z.object({
  notes: z.string().max(4000).optional(),
  improvementAreas: z.array(improvementAreaSchema).max(5).optional(),
  endedAt: z.string().datetime().optional(),
});

const BOARD_ORDER_BASELINE = DEFAULT_TRAINEE_LAYOUT.boardModuleOrder;
const CONTROL_ORDER_BASELINE = DEFAULT_TRAINEE_LAYOUT.controlButtonOrder;
const SIDE_ORDER_BASELINE = DEFAULT_TRAINEE_LAYOUT.sidePanelOrder;
const httpLogger = createLogger('HttpServer');

export function createHttpServer(domainContext: DomainContext, sessionManager: SessionManager): {
  app: Express;
  server: HttpServer;
  io: SocketIOServer;
} {
  const app = express();
  app.use(cors());
  app.use(express.json());
  const log = httpLogger;

  app.use((req, res, next) => {
    const start = Date.now();
    log.debug("Requête entrante", { method: req.method, path: req.originalUrl });
    res.on('finish', () => {
      log.info("Requête terminée", {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
    });
    res.on('error', (error) => {
      log.error("Erreur du flux de réponse", {
        error: toError(error),
        method: req.method,
        path: req.originalUrl,
      });
    });
    next();
  });

  const scenarioRunner = new ScenarioRunner(domainContext.domain);
  let latestLayout: TraineeLayoutConfig = DEFAULT_TRAINEE_LAYOUT;
  let ioRef: SocketIOServer | null = null;
  void loadTraineeLayout()
    .then((layout) => {
      latestLayout = layout;
      log.info("Disposition stagiaire chargée au démarrage");
    })
    .catch((error) => {
      log.error("Échec du chargement de la disposition stagiaire au démarrage", { error: toError(error) });
    });

  app.get('/api/users', async (req, res) => {
    const roleQuery = typeof req.query.role === 'string' ? req.query.role.toUpperCase() : undefined;
    const roleResult = roleQuery ? userRoleSchema.safeParse(roleQuery) : null;
    const where = roleResult?.success ? { role: roleResult.data } : undefined;
    const users = await prisma.user.findMany({
      where,
      orderBy: { fullName: 'asc' },
    });
    log.debug("Utilisateurs récupérés", { role: where?.role ?? 'ANY', count: users.length });
    res.json({ users: users.map(formatUser) });
  });

  app.post('/api/users', async (req, res) => {
    const parsed = userCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const data = parsed.data;
    try {
      const user = await prisma.user.create({
        data: {
          fullName: data.fullName.trim(),
          email: data.email ? data.email.trim().toLowerCase() : null,
          role: data.role,
        },
      });
      log.info("Utilisateur créé", { userId: user.id, role: user.role });
      res.status(201).json({ user: formatUser(user) });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return res.status(409).json({ error: 'EMAIL_ALREADY_IN_USE' });
      }
      log.error("Échec de la création de l'utilisateur", { error: toError(error) });
      res.status(500).json({ error: 'FAILED_TO_CREATE_USER' });
    }
  });

  app.put('/api/users/:id', async (req, res) => {
    const parsed = userUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const { id } = req.params;
    const data = parsed.data;
    try {
      const user = await prisma.user.update({
        where: { id },
        data: {
          fullName: data.fullName ? data.fullName.trim() : undefined,
          email:
            data.email === undefined
              ? undefined
              : data.email
              ? data.email.trim().toLowerCase()
              : null,
          role: data.role ?? undefined,
        },
      });
      log.info("Utilisateur mis à jour", { userId: user.id });
      res.json({ user: formatUser(user) });
    } catch (error) {
      if (isKnownRequestError(error)) {
        if (error.code === 'P2002') {
          return res.status(409).json({ error: 'EMAIL_ALREADY_IN_USE' });
        }
        if (error.code === 'P2025') {
          return res.status(404).json({ error: 'USER_NOT_FOUND' });
        }
      }
      log.error("Échec de la mise à jour de l'utilisateur", { error: toError(error), userId: id });
      res.status(500).json({ error: 'FAILED_TO_UPDATE_USER' });
    }
  });

  app.delete('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    const [sessionCount, scoreCount] = await Promise.all([
      prisma.session.count({ where: { OR: [{ traineeId: id }, { trainerId: id }] } }),
      prisma.score.count({ where: { userId: id } }),
    ]);
    if (sessionCount > 0 || scoreCount > 0) {
      return res.status(409).json({ error: 'USER_IN_USE' });
    }
    try {
      await prisma.user.delete({ where: { id } });
      log.info("Utilisateur supprimé", { userId: id });
      res.status(204).send();
    } catch (error) {
      if (isKnownRequestError(error) && error.code === 'P2025') {
        return res.status(404).json({ error: 'USER_NOT_FOUND' });
      }
      log.error("Échec de la suppression de l'utilisateur", { error: toError(error), userId: id });
      res.status(500).json({ error: 'FAILED_TO_DELETE_USER' });
    }
  });

  app.get('/api/sessions', async (req, res) => {
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const limit = Number.isFinite(limitRaw) && limitRaw! > 0 ? Math.min(Math.floor(limitRaw!), 100) : 20;
    try {
      const sessions = await sessionManager.listSessions(limit);
      log.debug("Sessions renvoyées", { limit, count: sessions.length });
      res.json({ sessions });
    } catch (error) {
      log.error("Échec de la récupération des sessions", { error: toError(error), limit });
      res.status(500).json({ error: 'FAILED_TO_LIST_SESSIONS' });
    }
  });

  app.get('/api/sessions/active', (_req, res) => {
    log.debug("Session active demandée");
    res.json({ session: sessionManager.getCurrentSession() });
  });

  app.post('/api/sessions', async (req, res) => {
    const parsed = sessionCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const payload = parsed.data;
    const name = payload.name.trim();
    if (!name) {
      return res.status(400).json({ error: 'INVALID_SESSION_NAME' });
    }
    const modeInput = payload.mode.trim();
    const objectiveInput = payload.objective?.trim() ?? '';
    const notesInput = payload.notes?.trim() ?? '';
    try {
      const session = await sessionManager.createSession({
        name,
        mode: modeInput.length > 0 ? modeInput : 'libre',
        traineeId: payload.traineeId,
        trainerId: payload.trainerId,
        objective: objectiveInput.length > 0 ? objectiveInput : undefined,
        notes: notesInput.length > 0 ? notesInput : undefined,
      });
      log.info("Session créée via l'API", { sessionId: session.id });
      res.status(201).json({ session });
    } catch (error) {
      if (error instanceof Error && error.message === 'SESSION_ALREADY_ACTIVE') {
        return res.status(409).json({ error: 'SESSION_ALREADY_ACTIVE' });
      }
      if (isKnownRequestError(error) && error.code === 'P2025') {
        return res.status(404).json({ error: 'RELATED_USER_NOT_FOUND' });
      }
      log.error("Échec de la création de la session", { error: toError(error) });
      res.status(500).json({ error: 'FAILED_TO_CREATE_SESSION' });
    }
  });

  app.put('/api/sessions/:id', async (req, res) => {
    const parsed = sessionUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const { id } = req.params;
    const payload = parsed.data;
    let nextName: string | undefined;
    if (payload.name !== undefined) {
      const trimmed = payload.name.trim();
      if (!trimmed) {
        return res.status(400).json({ error: 'INVALID_SESSION_NAME' });
      }
      nextName = trimmed;
    }
    let nextMode: string | undefined;
    if (payload.mode !== undefined) {
      const trimmed = payload.mode.trim();
      nextMode = trimmed.length > 0 ? trimmed : 'libre';
    }
    let nextObjective: string | null | undefined;
    if (payload.objective !== undefined) {
      if (payload.objective === null) {
        nextObjective = null;
      } else {
        const trimmed = payload.objective.trim();
        nextObjective = trimmed.length > 0 ? trimmed : null;
      }
    }
    let nextNotes: string | null | undefined;
    if (payload.notes !== undefined) {
      if (payload.notes === null) {
        nextNotes = null;
      } else {
        const trimmed = payload.notes.trim();
        nextNotes = trimmed.length > 0 ? trimmed : null;
      }
    }
    try {
      const session = await sessionManager.updateSession(id, {
        name: nextName,
        mode: nextMode,
        traineeId: payload.traineeId ?? undefined,
        trainerId: payload.trainerId ?? undefined,
        objective: nextObjective,
        notes: nextNotes,
      });
      log.info("Session mise à jour via l'API", { sessionId: session.id });
      res.json({ session });
    } catch (error) {
      if (isKnownRequestError(error) && error.code === 'P2025') {
        return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
      }
      if (isKnownRequestError(error) && error.code === 'P2003') {
        return res.status(404).json({ error: 'RELATED_USER_NOT_FOUND' });
      }
      log.error("Échec de la mise à jour de la session", { error: toError(error), sessionId: id });
      res.status(500).json({ error: 'FAILED_TO_UPDATE_SESSION' });
    }
  });

  app.post('/api/sessions/:id/close', async (req, res) => {
    const parsed = sessionCloseSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const { id } = req.params;
    const payload = parsed.data;
    const endedAt = payload.endedAt ? new Date(payload.endedAt) : undefined;
    let closeNotes: string | null | undefined;
    if (payload.notes !== undefined) {
      const trimmed = payload.notes.trim();
      closeNotes = trimmed.length > 0 ? trimmed : null;
    }
    try {
      const session = await sessionManager.closeSession(id, {
        notes: closeNotes,
        improvementAreas: normalizeImprovementAreas(payload.improvementAreas),
        endedAt,
      });
      log.info("Session clôturée via l'API", { sessionId: session.id });
      res.json({ session });
    } catch (error) {
      if (isKnownRequestError(error) && error.code === 'P2025') {
        return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
      }
      log.error("Échec de la clôture de la session", { error: toError(error), sessionId: id });
      res.status(500).json({ error: 'FAILED_TO_CLOSE_SESSION' });
    }
  });

  app.get('/api/sessions/:id/improvement-suggestions', async (req, res) => {
    const { id } = req.params;
    try {
      const session = await prisma.session.findUnique({ where: { id } });
      if (!session) {
        return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
      }
      const suggestions = await generateImprovementAreasForSession(id);
      log.info("Suggestions d'amélioration générées", {
        sessionId: id,
        improvementCount: suggestions.length,
      });
      res.json({ improvementAreas: suggestions });
    } catch (error) {
      log.error("Échec de la génération des suggestions d'amélioration", { error: toError(error), sessionId: id });
      res.status(500).json({ error: 'FAILED_TO_GENERATE_IMPROVEMENTS' });
    }
  });

  app.get('/api/config/site', async (_req, res) => {
    const config = await prisma.siteConfig.findUniqueOrThrow({ where: { id: 1 } });
    log.debug("Configuration du site récupérée");
    res.json({
      evacOnDAI: config.evacOnDAI,
      evacOnDMDelayMs: config.evacOnDMDelayMs,
      processAckRequired: config.processAckRequired,
    });
  });

  app.get('/api/config/trainee-layout', async (_req, res) => {
    try {
      const layout = await loadTraineeLayout();
      latestLayout = layout;
      log.debug("Disposition stagiaire récupérée");
      res.json(layout);
    } catch (error) {
      log.error("Échec de la récupération de la disposition stagiaire", { error: toError(error) });
      res.status(500).json({ error: 'FAILED_TO_FETCH_TRAINEE_LAYOUT' });
    }
  });

  app.put('/api/config/trainee-layout', async (req, res) => {
    const parsed = traineeLayoutSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const layout = parsed.data;
    if (!isValidLayoutSection(layout.boardModuleOrder, layout.boardModuleHidden, BOARD_ORDER_BASELINE)) {
      return res.status(400).json({ error: 'INVALID_BOARD_ORDER' });
    }
    if (!isValidLayoutSection(layout.controlButtonOrder, layout.controlButtonHidden, CONTROL_ORDER_BASELINE)) {
      return res.status(400).json({ error: 'INVALID_CONTROL_ORDER' });
    }
    if (!isValidLayoutSection(layout.sidePanelOrder, layout.sidePanelHidden, SIDE_ORDER_BASELINE)) {
      return res.status(400).json({ error: 'INVALID_PANEL_ORDER' });
    }
    try {
      const persisted = await persistTraineeLayout(layout);
      latestLayout = persisted;
      log.info("Disposition stagiaire mise à jour");
      res.json(persisted);
      if (ioRef) {
        ioRef.emit('layout.update', persisted);
      }
    } catch (error) {
      log.error("Échec de la sauvegarde de la disposition stagiaire", { error: toError(error) });
      res.status(500).json({ error: 'FAILED_TO_SAVE_TRAINEE_LAYOUT' });
    }
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
    log.info("Configuration du site mise à jour", {
      evacOnDAI: parsed.data.evacOnDAI,
      evacOnDMDelayMs: parsed.data.evacOnDMDelayMs,
      processAckRequired: parsed.data.processAckRequired,
    });
    res.json({
      evacOnDAI: config.evacOnDAI,
      evacOnDMDelayMs: config.evacOnDMDelayMs,
      processAckRequired: config.processAckRequired,
    });
  });

  app.get('/api/access/codes', async (_req, res) => {
    const rows = await prisma.$queryRaw<Array<{ level: number; code: string; updatedAt: string }>>`
      SELECT level, code, updatedAt FROM "AccessCode" ORDER BY level ASC
    `;
    const codes = rows.map((row) => ({
      level: Number(row.level),
      code: row.code,
      updatedAt: new Date(row.updatedAt).toISOString(),
    }));
    log.debug("Codes d'accès renvoyés", { count: codes.length });
    res.json({ codes });
  });

  app.put('/api/access/codes/:level', async (req, res) => {
    const level = Number(req.params.level);
    if (!Number.isFinite(level) || level < 1 || level > 3) {
      return res.status(400).json({ error: 'INVALID_LEVEL' });
    }
    const parsed = accessCodeUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const code = parsed.data.code.trim();
    const duplicates = await prisma.$queryRaw<Array<{ level: number }>>`
      SELECT level FROM "AccessCode" WHERE code = ${code} AND level != ${level} LIMIT 1
    `;
    if (duplicates.length > 0) {
      return res.status(409).json({ error: 'CODE_ALREADY_IN_USE' });
    }
    await prisma.$executeRaw`
      INSERT INTO "AccessCode" ("level", "code", "updatedAt") VALUES (${level}, ${code}, CURRENT_TIMESTAMP)
      ON CONFLICT("level") DO UPDATE SET "code" = excluded."code", "updatedAt" = CURRENT_TIMESTAMP
    `;
    const [record] = await prisma.$queryRaw<Array<{ level: number; code: string; updatedAt: string }>>`
      SELECT level, code, updatedAt FROM "AccessCode" WHERE level = ${level}
    `;
    if (!record) {
      return res.status(500).json({ error: 'ACCESS_CODE_NOT_FOUND' });
    }
    log.info("Code d'accès mis à jour", { level });
    res.json({
      code: {
        level: Number(record.level),
        code: record.code,
        updatedAt: new Date(record.updatedAt).toISOString(),
      },
    });
  });

  app.post('/api/access/verify', async (req, res) => {
    const parsed = accessCodeVerifySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const input = parsed.data.code.trim();
    if (input.length === 0) {
      log.debug("Vérification du code d'accès accordée par défaut");
      return res.json({ level: 1, allowed: true, label: 'Accès niveau 1 actif — arrêt signal sonore disponible.' });
    }
    const rows = await prisma.$queryRaw<Array<{ level: number }>>`
      SELECT level FROM "AccessCode" WHERE code = ${input} LIMIT 1
    `;
    if (rows.length === 0) {
      log.debug("Code d'accès refusé", { reason: 'unknown-code' });
      return res.json({ level: null, allowed: false, label: 'Code invalide — niveau courant conservé.' });
    }
    const level = Number(rows[0].level);
    if (level >= 3) {
      log.debug("Code d'accès refusé", { reason: 'level-3', level });
      return res.json({ level, allowed: false, label: 'Niveau 3 réservé au technicien de maintenance.' });
    }
    log.info("Code d'accès accepté", { level });
    return res.json({ level, allowed: true, label: `Accès niveau ${level} accordé — commandes avancées disponibles.` });
  });

  app.post('/api/process/ack', async (req, res) => {
    const ackedBy = z.string().min(1).parse(req.body?.ackedBy ?? 'trainer');
    await prisma.processAck.update({
      where: { id: 1 },
      data: { isAcked: true, ackedBy, ackedAt: new Date(), clearedAt: null },
    });
    domainContext.domain.acknowledgeProcess(ackedBy);
    log.info("Processus accusé réception", { ackedBy });
    res.status(204).send();
  });

  app.post('/api/process/clear', async (_req, res) => {
    await prisma.processAck.update({
      where: { id: 1 },
      data: { isAcked: false, clearedAt: new Date(), ackedAt: null, ackedBy: null },
    });
    domainContext.domain.clearProcessAck();
    log.info("Accusé de réception du processus annulé");
    res.status(204).send();
  });

  app.post('/api/uga/silence', async (_req, res) => {
    const snapshot = domainContext.snapshot();
    const wasActive = snapshot.ugaActive || snapshot.localAudibleActive;
    domainContext.domain.silenceAudibleAlarm();
    if (wasActive) {
      await prisma.eventLog.create({
        data: {
          source: 'TRAINEE',
          payloadJson: JSON.stringify({ action: 'uga-silence' }),
          sessionId: sessionManager.getActiveSessionId() ?? undefined,
        },
      });
    }
    log.info("Alarme sonore neutralisée", { wasActive });
    res.status(202).json({ status: 'audible-silenced' });
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
    log.info("Déclencheur manuel activé", { zoneId });
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
    log.info("Déclencheur manuel réarmé", { zoneId });
    res.status(200).json({ status: 'cleared', zoneId });
  });

  app.post('/api/sdi/dai/:zone/activate', async (req, res) => {
    const zoneId = req.params.zone;
    domainContext.domain.activateDai(zoneId);
    log.info("Détecteur automatique activé", { zoneId });
    res.status(202).json({ status: 'activated', zoneId });
  });

  app.post('/api/sdi/dai/:zone/reset', async (req, res) => {
    const zoneId = req.params.zone;
    domainContext.domain.resetDai(zoneId);
    log.info("Détecteur automatique réarmé", { zoneId });
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
        sessionId: sessionManager.getActiveSessionId() ?? undefined,
      },
    });
    log.info("Évacuation manuelle démarrée", { reason: parsed.data.reason });
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
        sessionId: sessionManager.getActiveSessionId() ?? undefined,
      },
    });
    log.info("Évacuation manuelle arrêtée", { reason: parsed.data.reason });
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
    log.info("Remise à zéro du système demandée");
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
    log.debug("Événements récupérés", {
      count: normalizedEvents.length,
      sessionId: sessionId ? String(sessionId) : undefined,
    });
    res.json({ events: normalizedEvents });
  });

  app.get('/api/state', (_req, res) => {
    log.debug("État du domaine demandé");
    res.json(domainContext.snapshot());
  });

  app.get('/api/topology', async (_req, res) => {
    const [zones, devices, config] = await Promise.all([
      prisma.zone.findMany({ orderBy: { label: 'asc' } }),
      prisma.device.findMany({ orderBy: { id: 'asc' } }),
      prisma.siteConfig.findUnique({ where: { id: 1 } }),
    ]);
    log.debug("Topologie récupérée", { zoneCount: zones.length, deviceCount: devices.length });
    res.json(
      formatTopologyResponse(zones, devices, {
        name: config?.planName ?? undefined,
        image: config?.planImage ?? undefined,
        notes: config?.planNotes ?? undefined,
      }),
    );
  });

  app.put('/api/topology', async (req, res) => {
    const parsed = siteTopologySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const { zones, devices, plan } = parsed.data;
    const zoneIds = new Set(zones.map((zone) => zone.id));
    for (const device of devices) {
      if (device.zoneId && !zoneIds.has(device.zoneId)) {
        return res.status(400).json({ error: `UNKNOWN_ZONE:${device.zoneId}` });
      }
    }
    try {
      await prisma.$transaction(async (tx) => {
        await tx.device.deleteMany();
        await tx.zone.deleteMany();
        if (zones.length > 0) {
          await tx.zone.createMany({
            data: zones.map((zone) => ({ id: zone.id, label: zone.label, kind: zone.kind })),
          });
        }
        if (devices.length > 0) {
          await tx.device.createMany({
            data: devices.map((device) => ({
              id: device.id,
              kind: device.kind,
              zoneId: device.zoneId ?? null,
              propsJson: device.props ? JSON.stringify(device.props) : null,
            })),
          });
        }
        const planPayload = plan?.image
          ? {
              planName: plan.name ?? null,
              planImage: plan.image,
              planNotes: plan.notes ?? null,
            }
          : { planName: null, planImage: null, planNotes: null };
        await tx.siteConfig.upsert({
          where: { id: 1 },
          update: planPayload,
          create: {
            id: 1,
            evacOnDAI: false,
            evacOnDMDelayMs: 300000,
            processAckRequired: true,
            ...planPayload,
          },
        });
      });
    } catch (error) {
      log.error("Échec de la sauvegarde de la topologie", { error: toError(error) });
      return res.status(500).json({ error: 'FAILED_TO_SAVE_TOPOLOGY' });
    }
    const [persistedZones, persistedDevices, persistedConfig] = await Promise.all([
      prisma.zone.findMany({ orderBy: { label: 'asc' } }),
      prisma.device.findMany({ orderBy: { id: 'asc' } }),
      prisma.siteConfig.findUnique({ where: { id: 1 } }),
    ]);
    const payload = formatTopologyResponse(persistedZones, persistedDevices, {
      name: persistedConfig?.planName ?? undefined,
      image: persistedConfig?.planImage ?? undefined,
      notes: persistedConfig?.planNotes ?? undefined,
    });
    log.info("Topologie mise à jour", {
      zoneCount: persistedZones.length,
      deviceCount: persistedDevices.length,
    });
    res.json(payload);
    if (ioRef) {
      ioRef.emit('topology.update', payload);
    }
  });

  app.get('/api/scenarios', async (_req, res) => {
    const records = await prisma.scenario.findMany({ orderBy: { name: 'asc' } });
    const scenarios = records.map(serializeScenarioRecord);
    log.debug("Scénarios renvoyés", { count: scenarios.length });
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
    const serializedPayload = {
      description: parsed.data.description,
      events: eventsWithIds,
      ...(parsed.data.topology ? { topology: parsed.data.topology } : {}),
    };
    const record = await prisma.scenario.create({
      data: {
        id: randomUUID(),
        name: parsed.data.name,
        json: JSON.stringify(serializedPayload),
      },
    });
    const scenario = scenarioDefinitionSchema.parse({
      id: record.id,
      name: record.name,
      description: parsed.data.description,
      events: eventsWithIds,
      ...(parsed.data.topology ? { topology: parsed.data.topology } : {}),
    });
    log.info("Scénario créé", { scenarioId: scenario.id });
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
    const serializedPayload = {
      description: parsed.data.description,
      events: eventsWithIds,
      ...(parsed.data.topology ? { topology: parsed.data.topology } : {}),
    };
    const record = await prisma.scenario.update({
      where: { id: req.params.id },
      data: {
        name: parsed.data.name,
        json: JSON.stringify(serializedPayload),
      },
    });
    const scenario = scenarioDefinitionSchema.parse({
      id: record.id,
      name: record.name,
      description: parsed.data.description,
      events: eventsWithIds,
      ...(parsed.data.topology ? { topology: parsed.data.topology } : {}),
    });
    log.info("Scénario mis à jour", { scenarioId: scenario.id });
    res.json({ scenario });
  });

  app.delete('/api/scenarios/:id', async (req, res) => {
    await prisma.scenario.delete({ where: { id: req.params.id } });
    log.info("Scénario supprimé", { scenarioId: req.params.id });
    res.status(204).send();
  });

  app.post('/api/scenarios/:id/run', async (req, res) => {
    const record = await prisma.scenario.findUnique({ where: { id: req.params.id } });
    if (!record) {
      return res.status(404).json({ error: 'SCENARIO_NOT_FOUND' });
    }
    const scenario = serializeScenarioRecord(record);
    scenarioRunner.run(scenario);
    log.info("Exécution de scénario demandée", { scenarioId: scenario.id });
    await prisma.eventLog.create({
      data: {
        source: 'TRAINER',
        payloadJson: JSON.stringify({ action: 'scenario-run', scenarioId: scenario.id }),
        sessionId: sessionManager.getActiveSessionId() ?? undefined,
      },
    });
    res.json(scenarioRunnerSnapshotSchema.parse(scenarioRunner.state));
  });

  app.post('/api/scenarios/stop', async (_req, res) => {
    const previousScenario = scenarioRunner.state.scenario;
    scenarioRunner.stop(previousScenario ? 'stopped' : 'idle');
    log.info("Arrêt de scénario demandé", { scenarioId: previousScenario?.id });
    if (previousScenario) {
      await prisma.eventLog.create({
        data: {
          source: 'TRAINER',
          payloadJson: JSON.stringify({ action: 'scenario-stop', scenarioId: previousScenario.id }),
          sessionId: sessionManager.getActiveSessionId() ?? undefined,
        },
      });
    }
    res.json(scenarioRunnerSnapshotSchema.parse(scenarioRunner.state));
  });

  app.get('/api/scenarios/active', (_req, res) => {
    log.debug("Instantané du scénario demandé");
    res.json(scenarioRunnerSnapshotSchema.parse(scenarioRunner.state));
  });

  const server = createServer(app);
  const io = new SocketIOServer(server, {
    cors: {
      origin: '*',
    },
  });
  ioRef = io;

  domainContext.domain.emitter.on('state.update', (snapshot) => {
    io.emit('state.update', snapshot);
  });

  domainContext.domain.emitter.on('events.append', (event) => {
    io.emit('events.append', event);
  });

  scenarioRunner.on('scenario.update', (snapshot) => {
    io.emit('scenario.update', snapshot);
  });

  sessionManager.on('session.update', (session) => {
    io.emit('session.update', session);
  });

  io.on('connection', (socket) => {
    log.debug("Client connecté au WebSocket", { socketId: socket.id });
    socket.emit('scenario.update', scenarioRunner.state);
    socket.emit('layout.update', latestLayout);
    socket.emit('session.update', sessionManager.getCurrentSession());
  });

  return { app, server: server as HttpServer, io };
}

function formatTopologyResponse(
  zones: Array<{ id: string; label: string; kind: string }>,
  devices: Array<{ id: string; kind: string; zoneId: string | null; propsJson: string | null }>,
  plan?: { name?: string; image?: string; notes?: string },
) {
  const planPayload = plan?.image
    ? {
        image: plan.image,
        name: plan.name ?? undefined,
        notes: plan.notes ?? undefined,
      }
    : undefined;
  return {
    plan: planPayload,
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
  };
}

function parseDeviceProps(json: string | null): Record<string, unknown> | undefined {
  if (!json) {
    return undefined;
  }
  try {
    const value = JSON.parse(json);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch (error) {
    httpLogger.error("Échec de l'analyse du JSON des attributs de dispositif", { error: toError(error) });
    return undefined;
  }
}

function isValidLayoutSection(order: string[], hidden: string[], baseline: string[]): boolean {
  const combined = [...order, ...hidden];
  if (combined.length !== baseline.length) {
    return false;
  }
  const seen = new Set(combined);
  if (seen.size !== baseline.length) {
    return false;
  }
  if (!baseline.every((item) => seen.has(item))) {
    return false;
  }
  return hidden.every((item) => baseline.includes(item));
}

function formatUser(user: { id: string; fullName: string; email: string | null; role: string }) {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
  };
}

function isKnownRequestError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError;
}

function isUniqueConstraintError(error: unknown): boolean {
  return isKnownRequestError(error) && error.code === 'P2002';
}

function normalizeImprovementAreas(
  areas: Array<{ title: string; description?: string | null }> | undefined,
): Array<{ title: string; description?: string | null }> | undefined {
  if (!areas) {
    return undefined;
  }
  const normalized = areas
    .map((area) => ({
      title: area.title.trim(),
      description: area.description?.trim() ?? undefined,
    }))
    .filter((area) => area.title.length > 0);
  return normalized;
}

async function loadTraineeLayout(): Promise<TraineeLayoutConfig> {
  const record = await prisma.traineeLayout.findUnique({ where: { id: 1 } });
  if (!record) {
    return DEFAULT_TRAINEE_LAYOUT;
  }
  try {
    const parsed = JSON.parse(record.configJson);
    const layout = traineeLayoutSchema.parse(parsed);
    if (
      isValidLayoutSection(layout.boardModuleOrder, layout.boardModuleHidden, BOARD_ORDER_BASELINE) &&
      isValidLayoutSection(layout.controlButtonOrder, layout.controlButtonHidden, CONTROL_ORDER_BASELINE) &&
      isValidLayoutSection(layout.sidePanelOrder, layout.sidePanelHidden, SIDE_ORDER_BASELINE)
    ) {
      return layout;
    }
  } catch (error) {
    httpLogger.error("Échec de l'analyse du JSON de la disposition stagiaire", { error: toError(error) });
  }
  return DEFAULT_TRAINEE_LAYOUT;
}

async function persistTraineeLayout(layout: TraineeLayoutConfig): Promise<TraineeLayoutConfig> {
  const json = JSON.stringify(layout);
  const record = await prisma.traineeLayout.upsert({
    where: { id: 1 },
    update: { configJson: json },
    create: { id: 1, configJson: json },
  });
  try {
    const parsed = JSON.parse(record.configJson);
    return traineeLayoutSchema.parse(parsed);
  } catch (error) {
    httpLogger.error("Échec de l'analyse du JSON de la disposition stagiaire enregistrée", { error: toError(error) });
    return DEFAULT_TRAINEE_LAYOUT;
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
  let payload: { description?: string; events: unknown; topology?: unknown };
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
    topology: payload && typeof payload === 'object' && payload.topology != null ? payload.topology : undefined,
  });
}
