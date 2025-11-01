import EventEmitter from 'eventemitter3';
import request from 'supertest';

import type { DomainContext } from '../state';
import type { SessionManager } from '../session-manager';
import { createHttpServer } from '../app';

jest.mock('../prisma', () => ({
  prisma: {
    zone: { findMany: jest.fn() },
    device: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    siteConfig: {
      findUnique: jest.fn(),
    },
    traineeLayout: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    processAck: { update: jest.fn() },
    eventLog: { create: jest.fn() },
    manualCallPoint: { updateMany: jest.fn(), update: jest.fn() },
    session: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

const { prisma: mockPrisma } = jest.requireMock('../prisma') as {
  prisma: {
    zone: { findMany: jest.Mock };
    device: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    siteConfig: { findUnique: jest.Mock };
    traineeLayout: { findUnique: jest.Mock; upsert: jest.Mock };
    processAck: { update: jest.Mock };
    eventLog: { create: jest.Mock };
    manualCallPoint: { updateMany: jest.Mock; update: jest.Mock };
    session: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
};

function createDomainContextStub(): DomainContext {
  const emitter = new EventEmitter();
  return {
    domain: {
      emitter,
      acknowledgeProcess: jest.fn(),
      clearProcessAck: jest.fn(),
      silenceAudibleAlarm: jest.fn(),
      activateDm: jest.fn(),
      resetDm: jest.fn(),
      activateDai: jest.fn(),
      resetDai: jest.fn(),
      startManualEvacuation: jest.fn(),
      stopManualEvacuation: jest.fn(),
      trySystemReset: jest.fn(() => ({ ok: true })),
    },
    snapshot: jest.fn(() => ({} as never)),
    refreshConfig: jest.fn(),
  } as unknown as DomainContext;
}

function createSessionManagerStub(): SessionManager {
  return {
    on: jest.fn(),
    emit: jest.fn(),
    getActiveSessionId: jest.fn(() => null),
    getCurrentSession: jest.fn(() => null),
    listSessions: jest.fn(),
    getSession: jest.fn(),
    createSession: jest.fn(),
    updateSession: jest.fn(),
    closeSession: jest.fn(),
  } as unknown as SessionManager;
}

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

describe('POST /api/devices/:id/out-of-service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.zone.findMany.mockResolvedValue([]);
    mockPrisma.device.findMany.mockResolvedValue([]);
    mockPrisma.siteConfig.findUnique.mockResolvedValue({
      id: 1,
      evacOnDAI: false,
      evacOnDMDelayMs: 300000,
      processAckRequired: true,
      planName: null,
      planImage: null,
      planNotes: null,
    });
    mockPrisma.traineeLayout.findUnique.mockResolvedValue(null);
    mockPrisma.device.update.mockResolvedValue({ id: 'ignored', outOfService: false });
  });

  it('returns success when the device only exists in the active topology', async () => {
    const runtimeDevice = {
      id: 'DEVICE-1',
      kind: 'DAI',
      zoneId: 'Z1',
      propsJson: null,
      outOfService: false,
    };
    mockPrisma.device.findMany.mockResolvedValue([runtimeDevice]);
    mockPrisma.device.findUnique.mockResolvedValue(null);

    const domainContext = createDomainContextStub();
    const sessionManager = createSessionManagerStub();
    const { app } = createHttpServer(domainContext, sessionManager);
    await flushAsync();

    const response = await request(app)
      .post(`/api/devices/${runtimeDevice.id}/out-of-service`)
      .send({ outOfService: true });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      device: { id: runtimeDevice.id, outOfService: true },
    });
    expect(mockPrisma.device.update).not.toHaveBeenCalled();
  });
});
