import { z } from 'zod';

const siteConfigSchema = z.object({
  evacOnDAI: z.boolean(),
  evacOnDMDelayMs: z.number(),
  processAckRequired: z.boolean(),
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;

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

  async updateSiteConfig(input: Pick<SiteConfig, 'evacOnDMDelayMs' | 'processAckRequired'>): Promise<SiteConfig> {
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

  async resetSystem() {
    await this.post('/api/system/reset');
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
