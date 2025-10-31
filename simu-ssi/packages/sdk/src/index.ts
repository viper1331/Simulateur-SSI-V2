import { z } from 'zod';

const siteConfigSchema = z.object({
  evacOnDAI: z.boolean(),
  evacOnDMDelayMs: z.number(),
  processAckRequired: z.boolean(),
});

const siteZoneSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.string().min(1),
});

const sitePlanSchema = z
  .object({
    image: z.string().min(1),
    name: z.string().min(1).optional(),
    notes: z.string().optional(),
  })
  .optional();

const siteDeviceSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  zoneId: z.string().min(1).optional(),
  label: z.string().optional(),
  props: z.record(z.unknown()).optional(),
});

const topologySchema = z.object({
  plan: sitePlanSchema,
  zones: z.array(siteZoneSchema),
  devices: z.array(siteDeviceSchema),
});

const scenarioEventBaseSchema = z.object({
  id: z.string().uuid().optional(),
  label: z.string().optional(),
  offset: z.number().min(0),
});

const scenarioZoneEvent = scenarioEventBaseSchema.extend({
  zoneId: z.string().min(1),
});

export const scenarioEventSchema = z.discriminatedUnion('type', [
  scenarioZoneEvent.extend({ type: z.literal('DM_TRIGGER') }),
  scenarioZoneEvent.extend({ type: z.literal('DM_RESET') }),
  scenarioZoneEvent.extend({ type: z.literal('DAI_TRIGGER') }),
  scenarioZoneEvent.extend({ type: z.literal('DAI_RESET') }),
  scenarioEventBaseSchema.extend({ type: z.literal('MANUAL_EVAC_START'), reason: z.string().optional() }),
  scenarioEventBaseSchema.extend({ type: z.literal('MANUAL_EVAC_STOP'), reason: z.string().optional() }),
  scenarioEventBaseSchema.extend({ type: z.literal('PROCESS_ACK'), ackedBy: z.string().optional() }),
  scenarioEventBaseSchema.extend({ type: z.literal('PROCESS_CLEAR') }),
  scenarioEventBaseSchema.extend({ type: z.literal('SYSTEM_RESET') }),
]);

export const scenarioDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  events: z.array(scenarioEventSchema),
});

export const scenarioPayloadSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  events: z.array(scenarioEventSchema).min(1),
});

export const scenarioRunnerSnapshotSchema = z.object({
  status: z.enum(['idle', 'running', 'completed', 'stopped']),
  scenario: scenarioDefinitionSchema.optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  currentEventIndex: z.number().int().optional(),
  nextEvent: scenarioEventSchema.nullish(),
  awaitingSystemReset: z.boolean().optional(),
});

const accessAuthorisationSchema = z.object({
  level: z.number().int().min(1).max(3).nullable(),
  allowed: z.boolean(),
  label: z.string(),
});

const accessCodeSchema = z.object({
  level: z.number().int().min(1).max(3),
  code: z.string().min(1),
  updatedAt: z.string(),
});

const accessCodeListSchema = z.object({
  codes: z.array(accessCodeSchema),
});

const layoutOrderSchema = z.array(z.string().min(1));
const layoutHiddenSchema = z.array(z.string().min(1)).default([]);

const userRoleSchema = z.enum(['TRAINER', 'TRAINEE']);

export const userSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string().min(1),
  email: z.string().email().nullable().optional(),
  role: userRoleSchema,
});

const userListSchema = z.object({
  users: z.array(userSchema),
});

export const sessionImprovementSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
});

export const sessionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  mode: z.string().min(1),
  objective: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  startedAt: z.string().min(1),
  endedAt: z.string().nullable().optional(),
  status: z.enum(['active', 'completed']),
  trainee: userSchema.nullable().optional(),
  trainer: userSchema.nullable().optional(),
  improvementAreas: z.array(sessionImprovementSchema),
});

const sessionListSchema = z.object({
  sessions: z.array(sessionSchema),
});

const sessionResponseSchema = z.object({
  session: sessionSchema.nullable(),
});

const improvementSuggestionSchema = z.object({
  improvementAreas: z.array(sessionImprovementSchema),
});

export const traineeLayoutSchema = z.object({
  boardModuleOrder: layoutOrderSchema,
  boardModuleHidden: layoutHiddenSchema,
  controlButtonOrder: layoutOrderSchema,
  controlButtonHidden: layoutHiddenSchema,
  sidePanelOrder: layoutOrderSchema,
  sidePanelHidden: layoutHiddenSchema,
});

export type TraineeLayoutConfig = z.infer<typeof traineeLayoutSchema>;
export type UserRole = z.infer<typeof userRoleSchema>;
export type UserSummary = z.infer<typeof userSchema>;
export type SessionImprovement = z.infer<typeof sessionImprovementSchema>;
export type SessionSummary = z.infer<typeof sessionSchema>;

export const DEFAULT_TRAINEE_LAYOUT: TraineeLayoutConfig = {
  boardModuleOrder: [
    'cmsi-status',
    'uga',
    'das',
    'manual-evac',
    'dai',
    'dm-zf1',
    'dm-zf2',
    'dm-zf3',
    'dm-zf4',
    'dm-zf5',
    'dm-zf6',
    'dm-zf7',
    'dm-zf8',
  ],
  boardModuleHidden: [],
  controlButtonOrder: ['silence', 'ack', 'reset-request', 'reset-dm-zf1', 'manual-evac-toggle'],
  controlButtonHidden: [],
  sidePanelOrder: ['access-control', 'event-recap', 'instructions'],
  sidePanelHidden: [],
};

export type SiteConfig = z.infer<typeof siteConfigSchema>;
export type ScenarioEvent = z.infer<typeof scenarioEventSchema>;
export type ScenarioDefinition = z.infer<typeof scenarioDefinitionSchema>;
export type ScenarioPayload = z.infer<typeof scenarioPayloadSchema>;
export type ScenarioRunnerSnapshot = z.infer<typeof scenarioRunnerSnapshotSchema>;
export type SiteZone = z.infer<typeof siteZoneSchema>;
export type SiteDevice = z.infer<typeof siteDeviceSchema>;
export type SiteTopology = z.infer<typeof topologySchema>;
export type AccessAuthorisation = z.infer<typeof accessAuthorisationSchema>;
export type AccessCode = z.infer<typeof accessCodeSchema>;
export const siteTopologySchema = topologySchema;

export interface UserCreateInput {
  fullName: string;
  role?: UserRole;
  email?: string;
}

export interface UserUpdateInput {
  fullName?: string;
  role?: UserRole;
  email?: string | null;
}

export interface SessionCreateRequest {
  name: string;
  mode?: string;
  traineeId?: string;
  trainerId?: string;
  objective?: string;
  notes?: string;
}

export interface SessionUpdateRequest {
  name?: string;
  mode?: string;
  traineeId?: string | null;
  trainerId?: string | null;
  objective?: string | null;
  notes?: string | null;
}

export interface SessionCloseRequest {
  notes?: string | null;
  improvementAreas?: SessionImprovement[];
  endedAt?: string;
}

export class SsiSdk {
  constructor(private readonly baseUrl: string) {}

  async getSiteConfig(): Promise<SiteConfig> {
    const response = await fetch(`${this.baseUrl}/api/config/site`);
    if (!response.ok) {
      throw new Error('Failed to fetch site config');
    }
    const json = await response.json();
    return siteConfigSchema.parse(json);
  }

  async updateSiteConfig(input: Pick<SiteConfig, 'evacOnDAI' | 'evacOnDMDelayMs' | 'processAckRequired'>): Promise<SiteConfig> {
    const response = await fetch(`${this.baseUrl}/api/config/site`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error('Failed to update site config');
    }
    const json = await response.json();
    return siteConfigSchema.parse(json);
  }

  async startManualEvacuation(reason?: string) {
    await this.post('/api/evac/manual/start', { reason });
  }

  async stopManualEvacuation(reason?: string) {
    await this.post('/api/evac/manual/stop', { reason });
  }

  async acknowledgeProcess(ackedBy: string) {
    await this.post('/api/process/ack', { ackedBy });
  }

  async clearProcessAck() {
    await this.post('/api/process/clear');
  }

  async silenceAudibleAlarm() {
    await this.post('/api/uga/silence');
  }

  async activateManualCallPoint(zoneId: string) {
    await this.post(`/api/sdi/dm/${zoneId}/activate`);
  }

  async resetManualCallPoint(zoneId: string) {
    await this.post(`/api/sdi/dm/${zoneId}/reset`);
  }

  async activateAutomaticDetector(zoneId: string) {
    await this.post(`/api/sdi/dai/${zoneId}/activate`);
  }

  async resetAutomaticDetector(zoneId: string) {
    await this.post(`/api/sdi/dai/${zoneId}/reset`);
  }

  async resetSystem() {
    await this.post('/api/system/reset');
  }

  async verifyAccessCode(code: string): Promise<AccessAuthorisation> {
    const response = await fetch(`${this.baseUrl}/api/access/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) {
      throw new Error('Failed to verify access code');
    }
    const json = await response.json();
    return accessAuthorisationSchema.parse(json);
  }

  async getAccessCodes(): Promise<AccessCode[]> {
    const response = await fetch(`${this.baseUrl}/api/access/codes`);
    if (!response.ok) {
      throw new Error('Failed to fetch access codes');
    }
    const json = await response.json();
    const parsed = accessCodeListSchema.parse(json);
    return parsed.codes;
  }

  async updateAccessCode(level: number, code: string): Promise<AccessCode> {
    const response = await fetch(`${this.baseUrl}/api/access/codes/${level}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      const message = errorBody?.error ?? 'Failed to update access code';
      throw new Error(message);
    }
    const json = await response.json();
    return accessCodeSchema.parse(json.code);
  }

  async listUsers(role?: UserRole): Promise<UserSummary[]> {
    const url = new URL('/api/users', this.baseUrl);
    if (role) {
      url.searchParams.set('role', role);
    }
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error('Failed to fetch users');
    }
    const json = await response.json();
    const parsed = userListSchema.parse(json);
    return parsed.users;
  }

  async createUser(input: UserCreateInput): Promise<UserSummary> {
    const response = await fetch(`${this.baseUrl}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error('Failed to create user');
    }
    const json = await response.json();
    return userSchema.parse(json.user);
  }

  async updateUser(id: string, input: UserUpdateInput): Promise<UserSummary> {
    const response = await fetch(`${this.baseUrl}/api/users/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error('Failed to update user');
    }
    const json = await response.json();
    return userSchema.parse(json.user);
  }

  async deleteUser(id: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/users/${id}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error('Failed to delete user');
    }
  }

  async listSessions(limit = 20): Promise<SessionSummary[]> {
    const url = new URL('/api/sessions', this.baseUrl);
    if (limit) {
      url.searchParams.set('limit', String(limit));
    }
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error('Failed to fetch sessions');
    }
    const json = await response.json();
    const parsed = sessionListSchema.parse(json);
    return parsed.sessions;
  }

  async getCurrentSession(): Promise<SessionSummary | null> {
    const response = await fetch(`${this.baseUrl}/api/sessions/active`);
    if (!response.ok) {
      throw new Error('Failed to fetch current session');
    }
    const json = await response.json();
    const parsed = sessionResponseSchema.parse(json);
    return parsed.session ?? null;
  }

  async createSession(payload: SessionCreateRequest): Promise<SessionSummary> {
    const response = await fetch(`${this.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error('Failed to create session');
    }
    const json = await response.json();
    return sessionSchema.parse(json.session);
  }

  async updateSession(id: string, payload: SessionUpdateRequest): Promise<SessionSummary> {
    const response = await fetch(`${this.baseUrl}/api/sessions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error('Failed to update session');
    }
    const json = await response.json();
    return sessionSchema.parse(json.session);
  }

  async generateImprovementSuggestions(sessionId: string): Promise<SessionImprovement[]> {
    const response = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/improvement-suggestions`);
    if (!response.ok) {
      throw new Error('Failed to generate improvement suggestions');
    }
    const json = await response.json();
    const parsed = improvementSuggestionSchema.parse(json);
    return parsed.improvementAreas;
  }

  async closeSession(id: string, payload: SessionCloseRequest = {}): Promise<SessionSummary> {
    const response = await fetch(`${this.baseUrl}/api/sessions/${id}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error('Failed to close session');
    }
    const json = await response.json();
    return sessionSchema.parse(json.session);
  }

  async getTraineeLayout(): Promise<TraineeLayoutConfig> {
    const response = await fetch(`${this.baseUrl}/api/config/trainee-layout`);
    if (!response.ok) {
      throw new Error('Failed to fetch trainee layout');
    }
    const json = await response.json();
    const parsed = traineeLayoutSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error('Invalid trainee layout payload');
    }
    return parsed.data;
  }

  async updateTraineeLayout(layout: TraineeLayoutConfig): Promise<TraineeLayoutConfig> {
    const response = await fetch(`${this.baseUrl}/api/config/trainee-layout`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layout),
    });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      const message = errorBody?.error ?? 'Failed to update trainee layout';
      throw new Error(message);
    }
    const json = await response.json();
    const parsed = traineeLayoutSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error('Invalid trainee layout payload');
    }
    return parsed.data;
  }

  async listScenarios(): Promise<ScenarioDefinition[]> {
    const response = await fetch(`${this.baseUrl}/api/scenarios`);
    if (!response.ok) {
      throw new Error('Failed to fetch scenarios');
    }
    const json = await response.json();
    return z.array(scenarioDefinitionSchema).parse(json.scenarios);
  }

  async getActiveScenario(): Promise<ScenarioRunnerSnapshot> {
    const response = await fetch(`${this.baseUrl}/api/scenarios/active`);
    if (!response.ok) {
      throw new Error('Failed to fetch scenario status');
    }
    const json = await response.json();
    return scenarioRunnerSnapshotSchema.parse(json);
  }

  async createScenario(payload: ScenarioPayload): Promise<ScenarioDefinition> {
    const response = await fetch(`${this.baseUrl}/api/scenarios`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error('Failed to create scenario');
    }
    const json = await response.json();
    return scenarioDefinitionSchema.parse(json.scenario);
  }

  async updateScenario(id: string, payload: ScenarioPayload): Promise<ScenarioDefinition> {
    const response = await fetch(`${this.baseUrl}/api/scenarios/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error('Failed to update scenario');
    }
    const json = await response.json();
    return scenarioDefinitionSchema.parse(json.scenario);
  }

  async deleteScenario(id: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/scenarios/${id}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error('Failed to delete scenario');
    }
  }

  async runScenario(id: string): Promise<ScenarioRunnerSnapshot> {
    const response = await fetch(`${this.baseUrl}/api/scenarios/${id}/run`, {
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error('Failed to run scenario');
    }
    const json = await response.json();
    return scenarioRunnerSnapshotSchema.parse(json);
  }

  async stopScenario(): Promise<ScenarioRunnerSnapshot> {
    const response = await fetch(`${this.baseUrl}/api/scenarios/stop`, {
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error('Failed to stop scenario');
    }
    const json = await response.json();
    return scenarioRunnerSnapshotSchema.parse(json);
  }

  async getTopology(): Promise<SiteTopology> {
    const response = await fetch(`${this.baseUrl}/api/topology`);
    if (!response.ok) {
      throw new Error('Failed to fetch topology');
    }
    const json = await response.json();
    return topologySchema.parse(json);
  }

  async updateTopology(topology: SiteTopology): Promise<SiteTopology> {
    const response = await fetch(`${this.baseUrl}/api/topology`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(topology),
    });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      const message = errorBody?.error ?? 'Failed to update topology';
      throw new Error(message);
    }
    const json = await response.json();
    return topologySchema.parse(json);
  }

  private async post(path: string, body?: unknown) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
  }
}
