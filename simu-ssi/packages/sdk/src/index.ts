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

const siteDeviceSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  zoneId: z.string().min(1).optional(),
  label: z.string().optional(),
  props: z.record(z.unknown()).optional(),
});

const topologySchema = z.object({
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
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;
export type ScenarioEvent = z.infer<typeof scenarioEventSchema>;
export type ScenarioDefinition = z.infer<typeof scenarioDefinitionSchema>;
export type ScenarioPayload = z.infer<typeof scenarioPayloadSchema>;
export type ScenarioRunnerSnapshot = z.infer<typeof scenarioRunnerSnapshotSchema>;
export type SiteZone = z.infer<typeof siteZoneSchema>;
export type SiteDevice = z.infer<typeof siteDeviceSchema>;
export type SiteTopology = z.infer<typeof topologySchema>;

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
