import EventEmitter from 'eventemitter3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './prisma';
import type { Prisma } from '@prisma/client';

const improvementSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
});

type ImprovementArea = z.infer<typeof improvementSchema>;

type SessionWithRelations = Prisma.SessionGetPayload<{
  include: { trainee: true; trainer: true };
}>;

export interface SessionView {
  id: string;
  name: string;
  mode: string;
  objective?: string | null;
  notes?: string | null;
  startedAt: string;
  endedAt?: string | null;
  status: 'active' | 'completed';
  trainee?: UserSummary | null;
  trainer?: UserSummary | null;
  improvementAreas: ImprovementArea[];
}

export interface UserSummary {
  id: string;
  fullName: string;
  role: 'TRAINER' | 'TRAINEE';
  email?: string | null;
}

export interface SessionCreateInput {
  name: string;
  mode?: string;
  traineeId?: string;
  trainerId?: string;
  objective?: string;
  notes?: string;
}

export interface SessionUpdateInput {
  name?: string;
  mode?: string;
  traineeId?: string | null;
  trainerId?: string | null;
  objective?: string | null;
  notes?: string | null;
}

export interface SessionCloseInput {
  notes?: string;
  improvementAreas?: ImprovementArea[];
  endedAt?: Date;
}

interface SessionManagerEventMap {
  'session.update': SessionView | null;
}

export class SessionManager extends EventEmitter<SessionManagerEventMap> {
  private activeSessionId: string | null = null;

  private currentSession: SessionView | null = null;

  async hydrate() {
    const record = await prisma.session.findFirst({
      orderBy: { startedAt: 'desc' },
      include: { trainee: true, trainer: true },
    });
    if (!record) {
      this.activeSessionId = null;
      this.currentSession = null;
      return null;
    }
    this.activeSessionId = record.endedAt ? null : record.id;
    this.currentSession = this.serialize(record);
    return this.currentSession;
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  getCurrentSession(): SessionView | null {
    return this.currentSession;
  }

  async listSessions(limit = 20): Promise<SessionView[]> {
    const records = await prisma.session.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: { trainee: true, trainer: true },
    });
    return records.map((record) => this.serialize(record));
  }

  async getSession(id: string): Promise<SessionView | null> {
    const record = await prisma.session.findUnique({
      where: { id },
      include: { trainee: true, trainer: true },
    });
    return record ? this.serialize(record) : null;
  }

  async createSession(input: SessionCreateInput): Promise<SessionView> {
    if (this.activeSessionId) {
      throw new Error('SESSION_ALREADY_ACTIVE');
    }
    const session = await prisma.session.create({
      data: {
        id: randomUUID(),
        name: input.name,
        mode: input.mode ?? 'libre',
        traineeId: input.traineeId ?? undefined,
        trainerId: input.trainerId ?? undefined,
        objective: input.objective ?? undefined,
        notes: input.notes ?? undefined,
      },
      include: { trainee: true, trainer: true },
    });
    this.activeSessionId = session.id;
    this.currentSession = this.serialize(session);
    this.emit('session.update', this.currentSession);
    return this.currentSession;
  }

  async updateSession(id: string, input: SessionUpdateInput): Promise<SessionView> {
    const session = await prisma.session.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        mode: input.mode ?? undefined,
        traineeId: input.traineeId === undefined ? undefined : input.traineeId ?? null,
        trainerId: input.trainerId === undefined ? undefined : input.trainerId ?? null,
        objective: input.objective === undefined ? undefined : input.objective ?? null,
        notes: input.notes === undefined ? undefined : input.notes ?? null,
      },
      include: { trainee: true, trainer: true },
    });
    this.activeSessionId = session.endedAt ? null : session.id;
    if (!this.currentSession || this.currentSession.id === session.id) {
      this.currentSession = this.serialize(session);
      this.emit('session.update', this.currentSession);
    }
    return this.serialize(session);
  }

  async closeSession(id: string, input: SessionCloseInput): Promise<SessionView> {
    const improvementJson =
      input.improvementAreas === undefined
        ? undefined
        : input.improvementAreas.length > 0
        ? JSON.stringify(input.improvementAreas)
        : null;
    const session = await prisma.session.update({
      where: { id },
      data: {
        notes: input.notes === undefined ? undefined : input.notes ?? null,
        improvementJson: improvementJson === undefined ? undefined : improvementJson,
        endedAt: input.endedAt ?? new Date(),
      },
      include: { trainee: true, trainer: true },
    });
    if (this.activeSessionId === id) {
      this.activeSessionId = null;
    }
    this.currentSession = this.serialize(session);
    this.emit('session.update', this.currentSession);
    return this.currentSession;
  }

  private serialize(record: SessionWithRelations): SessionView {
    return {
      id: record.id,
      name: record.name,
      mode: record.mode,
      objective: record.objective,
      notes: record.notes,
      startedAt: record.startedAt.toISOString(),
      endedAt: record.endedAt ? record.endedAt.toISOString() : null,
      status: record.endedAt ? 'completed' : 'active',
      trainee: record.trainee ? serializeUser(record.trainee) : null,
      trainer: record.trainer ? serializeUser(record.trainer) : null,
      improvementAreas: parseImprovementAreas(record.improvementJson),
    };
  }
}

function serializeUser(user: { id: string; fullName: string; role: string; email: string | null }): UserSummary {
  return {
    id: user.id,
    fullName: user.fullName,
    role: (user.role as UserSummary['role']) ?? 'TRAINEE',
    email: user.email,
  };
}

function parseImprovementAreas(json: string | null): ImprovementArea[] {
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const result: ImprovementArea[] = [];
    for (const item of parsed) {
      const validation = improvementSchema.safeParse(item);
      if (validation.success) {
        result.push(validation.data);
      }
    }
    return result;
  } catch (error) {
    console.error('Failed to parse improvement axes JSON', error);
    return [];
  }
}
