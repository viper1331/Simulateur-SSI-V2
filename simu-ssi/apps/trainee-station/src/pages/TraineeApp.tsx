import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { io } from 'socket.io-client';
import {
  DEFAULT_TRAINEE_LAYOUT,
  SsiSdk,
  traineeLayoutSchema,
  siteTopologySchema,
  type SiteDevice,
  type SiteTopology,
  type ScenarioEvent,
  type ScenarioRunnerSnapshot,
  type ScenarioAudioAsset,
  type TraineeLayoutConfig,
  type SessionSummary,
  sessionSchema,
  type UserSummary,
} from '@simu-ssi/sdk';

interface CmsiStateData {
  status: string;
  manual?: boolean;
  deadline?: number;
  remainingMs?: number;
  zoneId?: string;
  startedAt?: number;
}

interface Snapshot {
  cmsi: CmsiStateData;
  ugaActive: boolean;
  localAudibleActive: boolean;
  dasApplied: boolean;
  manualEvacuation: boolean;
  processAck: { isAcked: boolean };
  dmLatched: Record<string, { zoneId: string }>;
  daiActivated: Record<string, { zoneId: string }>;
}

type BoardModuleTone = 'alarm' | 'info' | 'safe' | 'warning';

interface BoardModule {
  id: string;
  label: string;
  description: string;
  tone: BoardModuleTone;
  active: boolean;
  highlighted?: boolean;
}

const cmsiStatusLabel: Record<string, string> = {
  EVAC_ACTIVE: 'Évacuation générale déclenchée',
  EVAC_PENDING: 'Préalarme en cours',
  EVAC_SUSPENDED: 'Suspendu - attente réarmement',
  SAFE_HOLD: 'Maintien en sécurité',
};

const cmsiStatusTone: Record<string, BoardModuleTone> = {
  EVAC_ACTIVE: 'alarm',
  EVAC_PENDING: 'warning',
  EVAC_SUSPENDED: 'info',
  SAFE_HOLD: 'safe',
};

const DEVICE_MARKER_LABELS: Record<string, string> = {
  DM: 'DM',
  DAI: 'DAI',
  DAS: 'DAS',
  UGA: 'UGA',
};

const LOWEST_ACCESS_LEVEL = 1;
const LOWEST_ACCESS_MESSAGE = 'Niveau 1 actif — arrêt signal sonore disponible.';
const ACCESS_LEVEL_AUTO_RESET_DELAY_MS = 100_000;

function translateScenarioStatus(
  status: ScenarioRunnerSnapshot['status'],
  awaitingSystemReset?: boolean,
): string {
  if (status === 'running' && awaitingSystemReset) {
    return 'En attente de réarmement';
  }
  switch (status) {
    case 'running':
      return 'Scénario en cours';
    case 'completed':
      return 'Scénario terminé';
    case 'stopped':
      return 'Scénario interrompu';
    default:
      return 'Mode libre';
  }
}

function describeScenarioEvent(status: ScenarioRunnerSnapshot): string {
  if (status.awaitingSystemReset) {
    return 'Réarmez le système pour terminer le scénario';
  }
  const event = status.nextEvent;
  if (!event) return 'Aucun événement programmé';
  switch (event.type) {
    case 'DM_TRIGGER':
      return `DM ${event.zoneId}`;
    case 'DM_RESET':
      return `Réarmement DM ${event.zoneId}`;
    case 'DAI_TRIGGER':
      return `Détection DAI ${event.zoneId}`;
    case 'DAI_RESET':
      return `Réarmement DAI ${event.zoneId}`;
    case 'MANUAL_EVAC_START':
      return 'Début évacuation manuelle';
    case 'MANUAL_EVAC_STOP':
      return 'Fin évacuation manuelle';
    case 'PROCESS_ACK':
      return `Acquit process (${event.ackedBy ?? 'formateur'})`;
    case 'PROCESS_CLEAR':
      return 'Nettoyage acquit';
    case 'SYSTEM_RESET':
      return 'Reset système';
    default:
      return 'Action scénarisée';
  }
}

interface ScenarioAdaptationStep {
  id: string;
  label: string;
  completed: boolean;
  isNext: boolean;
}

interface ScenarioAdaptation {
  boardHighlights: Set<string>;
  controlHighlights: Set<string>;
  steps: ScenarioAdaptationStep[];
  description?: string;
}

type ManualResetConstraints = {
  dmZones: Set<string>;
  daiZones: Set<string>;
};

type ScenarioEventTone = 'alarm' | 'info' | 'success' | 'warning';

interface TriggeredScenarioEventCard {
  id: string;
  label: string;
  zoneDisplay: string;
  offsetLabel: string;
  tone: ScenarioEventTone;
}

function getScenarioEventTone(event: ScenarioEvent): ScenarioEventTone {
  switch (event.type) {
    case 'DM_TRIGGER':
    case 'DAI_TRIGGER':
      return 'alarm';
    case 'MANUAL_EVAC_START':
      return 'warning';
    case 'SYSTEM_RESET':
      return 'success';
    default:
      return 'info';
  }
}

function isScenarioEventActive(event: ScenarioEvent, snapshot: Snapshot | null): boolean {
  if (!snapshot) {
    return true;
  }
  switch (event.type) {
    case 'DM_TRIGGER':
      return Boolean(snapshot.dmLatched?.[event.zoneId]);
    case 'DAI_TRIGGER':
      return Boolean(snapshot.daiActivated?.[event.zoneId]);
    case 'MANUAL_EVAC_START':
      return Boolean(snapshot.manualEvacuation);
    case 'PROCESS_ACK':
      return Boolean(snapshot.processAck?.isAcked);
    case 'SYSTEM_RESET':
      return snapshot.cmsi.status !== 'IDLE';
    case 'MANUAL_EVAC_STOP':
    case 'DM_RESET':
    case 'DAI_RESET':
    case 'PROCESS_CLEAR':
      return false;
    default:
      return true;
  }
}

function isManualResetAllowed(
  constraints: ManualResetConstraints | null,
  kind: 'DM' | 'DAI',
  zoneId: string,
): boolean {
  if (!constraints) {
    return true;
  }
  const normalizedZone = zoneId.trim().toUpperCase();
  if (kind === 'DM') {
    if (constraints.dmZones.size === 0) {
      return true;
    }
    return constraints.dmZones.has(normalizedZone);
  }
  if (kind === 'DAI') {
    if (constraints.daiZones.size === 0) {
      return true;
    }
    return constraints.daiZones.has(normalizedZone);
  }
  return true;
}

function formatScenarioOffset(offset: number): string {
  if (!Number.isFinite(offset)) {
    return '';
  }
  if (offset === 0) {
    return 'T0';
  }
  const rounded = Number.isInteger(offset) ? offset : Number(offset.toFixed(1));
  return `T+${rounded}s`;
}

function describeScenarioStep(event: ScenarioEvent): string {
  if (event.label && event.label.trim().length > 0) {
    return event.label.trim();
  }
  switch (event.type) {
    case 'DM_TRIGGER':
      return `Déclenchement DM ${event.zoneId}`;
    case 'DM_RESET':
      return `Réarmement DM ${event.zoneId}`;
    case 'DAI_TRIGGER':
      return `Détection DAI ${event.zoneId}`;
    case 'DAI_RESET':
      return `Réarmement DAI ${event.zoneId}`;
    case 'MANUAL_EVAC_START':
      return "Début évacuation manuelle";
    case 'MANUAL_EVAC_STOP':
      return 'Fin évacuation manuelle';
    case 'PROCESS_ACK':
      return 'Acquittement process';
    case 'PROCESS_CLEAR':
      return "Nettoyage de l'acquit";
    case 'SYSTEM_RESET':
      return 'Réarmement système';
    default:
      return 'Action scénarisée';
  }
}

function formatDateTime(iso?: string | null): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString();
}

function applyHighlightsForEvent(
  event: ScenarioEvent,
  boardHighlights: Set<string>,
  controlHighlights: Set<string>,
) {
  switch (event.type) {
    case 'DM_TRIGGER':
    case 'DM_RESET': {
      const boardId = `dm-${event.zoneId.toLowerCase()}`;
      boardHighlights.add(boardId);
      if (event.zoneId.toUpperCase() === 'ZF1') {
        controlHighlights.add('reset-dm-zf1');
      }
      break;
    }
    case 'DAI_TRIGGER':
    case 'DAI_RESET':
      boardHighlights.add('dai');
      break;
    case 'MANUAL_EVAC_START':
    case 'MANUAL_EVAC_STOP':
      boardHighlights.add('manual-evac');
      boardHighlights.add('uga');
      controlHighlights.add('manual-evac-toggle');
      break;
    case 'PROCESS_ACK':
    case 'PROCESS_CLEAR':
      controlHighlights.add('ack');
      boardHighlights.add('cmsi-status');
      break;
    case 'SYSTEM_RESET':
      controlHighlights.add('reset-request');
      boardHighlights.add('cmsi-status');
      break;
    default:
      break;
  }
}

function deriveScenarioAdaptation(status?: ScenarioRunnerSnapshot | null): ScenarioAdaptation {
  const boardHighlights = new Set<string>();
  const controlHighlights = new Set<string>();
  const steps: ScenarioAdaptationStep[] = [];
  if (!status?.scenario) {
    return { boardHighlights, controlHighlights, steps, description: undefined };
  }
  const scenario = status.scenario;
  const orderedEvents = [...scenario.events].sort((a, b) => a.offset - b.offset);
  const currentIndex = status.currentEventIndex ?? -1;
  const awaitingReset = Boolean(status.awaitingSystemReset);
  const resolvedCurrentIndex = awaitingReset ? Math.max(-1, currentIndex - 1) : currentIndex;
  const explicitNextEvent = status.nextEvent ?? null;
  const fallbackNextEvent = orderedEvents[currentIndex + 1] ?? null;
  const nextEvent = explicitNextEvent ?? fallbackNextEvent;

  orderedEvents.forEach((event, index) => {
    const offsetLabel = formatScenarioOffset(event.offset);
    const actionLabel = describeScenarioStep(event);
    const line = offsetLabel ? `${offsetLabel} · ${actionLabel}` : actionLabel;
    const completed = index <= resolvedCurrentIndex;
    const hasUpcoming = resolvedCurrentIndex < orderedEvents.length - 1;
    const upcomingIndex = Math.min(orderedEvents.length - 1, resolvedCurrentIndex + 1);
    const isNext = awaitingReset
      ? Boolean(nextEvent && nextEvent === event)
      : hasUpcoming && index === upcomingIndex;
    const zonePart = 'zoneId' in event && typeof event.zoneId === 'string' ? event.zoneId : 'none';
    steps.push({
      id: `${index}-${event.type}-${zonePart}-${event.offset}`,
      label: line,
      completed,
      isNext,
    });
  });

  if (nextEvent) {
    applyHighlightsForEvent(nextEvent, boardHighlights, controlHighlights);
  }

  if (awaitingReset && !nextEvent) {
    boardHighlights.add('cmsi-status');
    controlHighlights.add('reset-request');
  }

  return {
    boardHighlights,
    controlHighlights,
    steps,
    description: scenario.description?.trim() || undefined,
  };
}

function orderItems<T extends { id: string }>(items: T[], order: string[], hidden: string[] = []): T[] {
  const hiddenSet = new Set(hidden);
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  return items
    .filter((item) => !hiddenSet.has(item.id))
    .map((item, originalIndex) => ({ item, originalIndex }))
    .sort((a, b) => {
      const aIndex = orderIndex.has(a.item.id) ? orderIndex.get(a.item.id)! : order.length + a.originalIndex;
      const bIndex = orderIndex.has(b.item.id) ? orderIndex.get(b.item.id)! : order.length + b.originalIndex;
      return aIndex - bIndex;
    })
    .map(({ item }) => item);
}

function splitPlanNotes(value?: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function extractPlanNotes(topology: SiteTopology | null): string[] {
  if (!topology) {
    return [];
  }
  const notes = new Set<string>();
  for (const note of splitPlanNotes(topology.plan?.notes)) {
    notes.add(note);
  }
  for (const device of topology.devices) {
    const props = device.props as Record<string, unknown> | undefined;
    const rawNotes = props?.planNotes;
    if (typeof rawNotes === 'string') {
      for (const line of splitPlanNotes(rawNotes)) {
        notes.add(line);
      }
    }
  }
  return Array.from(notes);
}

function getDevicePosition(device: SiteDevice): { x: number; y: number } | null {
  const props = device.props as Record<string, unknown> | undefined;
  if (!props) {
    return null;
  }
  const coordinates = props.coordinates as { xPercent?: number; yPercent?: number } | undefined;
  const xValue = typeof props.x === 'number' ? props.x : coordinates?.xPercent;
  const yValue = typeof props.y === 'number' ? props.y : coordinates?.yPercent;
  if (typeof xValue !== 'number' || typeof yValue !== 'number') {
    return null;
  }
  return { x: xValue, y: yValue };
}

function isDeviceActive(device: SiteDevice, snapshot: Snapshot | null): boolean {
  if (!snapshot) {
    return false;
  }
  switch (device.kind) {
    case 'DM':
      return device.zoneId ? Boolean(snapshot.dmLatched?.[device.zoneId]) : false;
    case 'DAI':
      return device.zoneId ? Boolean(snapshot.daiActivated?.[device.zoneId]) : false;
    case 'DAS':
      return Boolean(snapshot.dasApplied);
    case 'UGA':
      return Boolean(snapshot.ugaActive || snapshot.localAudibleActive);
    default:
      return false;
  }
}

function isDeviceActionable(
  device: SiteDevice,
  snapshot: Snapshot | null,
  accessLevel: number,
  manualConstraints: ManualResetConstraints | null,
): boolean {
  if (accessLevel < 2) {
    return false;
  }
  if (device.kind === 'DM' && device.zoneId) {
    const isActive = Boolean(snapshot?.dmLatched?.[device.zoneId]);
    if (!isActive) {
      return false;
    }
    return isManualResetAllowed(manualConstraints, 'DM', device.zoneId);
  }
  if (device.kind === 'DAI' && device.zoneId) {
    const isActive = Boolean(snapshot?.daiActivated?.[device.zoneId]);
    if (!isActive) {
      return false;
    }
    return isManualResetAllowed(manualConstraints, 'DAI', device.zoneId);
  }
  return false;
}

export function TraineeApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [scenarioStatus, setScenarioStatus] = useState<ScenarioRunnerSnapshot>({ status: 'idle' });
  const [accessLevel, setAccessLevel] = useState<number>(LOWEST_ACCESS_LEVEL);
  const [ledMessage, setLedMessage] = useState<string>(LOWEST_ACCESS_MESSAGE);
  const [codeBuffer, setCodeBuffer] = useState<string>('');
  const [verifyingAccess, setVerifyingAccess] = useState<boolean>(false);
  const [accessLevelExpiryRevision, setAccessLevelExpiryRevision] = useState<number>(0);
  const [layout, setLayout] = useState<TraineeLayoutConfig>(DEFAULT_TRAINEE_LAYOUT);
  const [topology, setTopology] = useState<SiteTopology | null>(null);
  const [planNotes, setPlanNotes] = useState<string[]>([]);
  const [sessionInfo, setSessionInfo] = useState<SessionSummary | null>(null);
  const [traineeOptions, setTraineeOptions] = useState<UserSummary[]>([]);
  const [traineeLoading, setTraineeLoading] = useState<boolean>(true);
  const [traineeError, setTraineeError] = useState<string | null>(null);
  const [selectedTraineeId, setSelectedTraineeId] = useState<string>('');
  const [activeTrainee, setActiveTrainee] = useState<UserSummary | null>(null);
  const [traineeAuthError, setTraineeAuthError] = useState<string | null>(null);
  const [traineeAuthPending, setTraineeAuthPending] = useState<boolean>(false);
  const baseUrl = useMemo(() => import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4500', []);
  const sdk = useMemo(() => new SsiSdk(baseUrl), [baseUrl]);
  const improvementAreas = sessionInfo?.improvementAreas ?? [];
  const scenarioStatusRef = useRef<ScenarioRunnerSnapshot>({ status: 'idle' });
  const pendingTopologyRef = useRef<SiteTopology | null>(null);
  const accessLevelResetTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const evacuationAudioRef = useRef<HTMLAudioElement | null>(null);

  const scenarioUiStatus = useMemo<ScenarioRunnerSnapshot>(
    () =>
      scenarioStatus.status === 'stopped'
        ? {
            ...scenarioStatus,
            scenario: undefined,
            nextEvent: null,
            awaitingSystemReset: false,
          }
        : scenarioStatus,
    [scenarioStatus],
  );

  const manualResetConstraints = useMemo<ManualResetConstraints | null>(() => {
    const config = scenarioUiStatus.scenario?.manualResettable;
    if (!config) {
      return null;
    }
    const normalize = (zone: string) => zone.trim().toUpperCase();
    const dmZones = new Set(
      (config.dmZones ?? [])
        .map(normalize)
        .filter((zone) => zone.length > 0),
    );
    const daiZones = new Set(
      (config.daiZones ?? [])
        .map(normalize)
        .filter((zone) => zone.length > 0),
    );
    return { dmZones, daiZones };
  }, [scenarioUiStatus.scenario?.manualResettable]);

  const hasOutstandingManualResets = useMemo(() => {
    const normalize = (zone: string) => zone.trim().toUpperCase();
    const dmLatched = snapshot?.dmLatched ?? {};
    const daiActivated = snapshot?.daiActivated ?? {};
    const activeDmZones = Object.keys(dmLatched).map(normalize);
    const activeDaiZones = Object.keys(daiActivated).map(normalize);

    if (!manualResetConstraints) {
      return activeDmZones.length > 0 || activeDaiZones.length > 0;
    }

    const requiresManualDm = manualResetConstraints.dmZones.size > 0;
    const requiresManualDai = manualResetConstraints.daiZones.size > 0;

    const pendingDm =
      requiresManualDm && activeDmZones.some((zone) => manualResetConstraints.dmZones.has(zone));
    const pendingDai =
      requiresManualDai && activeDaiZones.some((zone) => manualResetConstraints.daiZones.has(zone));

    return pendingDm || pendingDai;
  }, [manualResetConstraints, snapshot?.daiActivated, snapshot?.dmLatched]);

  const canResetZone = useCallback(
    (kind: 'DM' | 'DAI', zoneId: string) => isManualResetAllowed(manualResetConstraints, kind, zoneId),
    [manualResetConstraints],
  );

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const socket = io(baseUrl);
    socket.on('state.update', (state: Snapshot) => setSnapshot(state));
    socket.on('scenario.update', (status: ScenarioRunnerSnapshot) => setScenarioStatus(status));
    socket.on('layout.update', (payload) => {
      const parsed = traineeLayoutSchema.safeParse(payload);
      if (parsed.success) {
        setLayout(parsed.data);
      }
    });
    socket.on('topology.update', (payload) => {
      const parsed = siteTopologySchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }
      pendingTopologyRef.current = parsed.data;
      if (scenarioStatusRef.current.status === 'running') {
        setTopology(parsed.data);
        pendingTopologyRef.current = null;
      }
    });
    socket.on('session.update', (payload) => {
      if (payload === null) {
        setSessionInfo(null);
        return;
      }
      const parsed = sessionSchema.safeParse(payload);
      if (parsed.success) {
        setSessionInfo(parsed.data);
      }
    });
    return () => {
      socket.disconnect();
    };
  }, [baseUrl]);

  useEffect(() => {
    sdk.getActiveScenario().then(setScenarioStatus).catch(console.error);
  }, [sdk]);

  useEffect(() => {
    sdk
      .getTraineeLayout()
      .then(setLayout)
      .catch((error) => {
        console.error(error);
        setLayout(DEFAULT_TRAINEE_LAYOUT);
      });
  }, [sdk]);

  useEffect(() => {
    setPlanNotes(extractPlanNotes(topology));
  }, [topology]);

  useEffect(() => {
    scenarioStatusRef.current = scenarioStatus;
    if (scenarioStatus.status !== 'running') {
      setTopology(null);
      return;
    }
    if (pendingTopologyRef.current) {
      setTopology(pendingTopologyRef.current);
      pendingTopologyRef.current = null;
    }
  }, [scenarioStatus]);

  useEffect(() => {
    sdk.getCurrentSession().then(setSessionInfo).catch(console.error);
  }, [sdk]);

  useEffect(() => {
    setTraineeLoading(true);
    sdk
      .listUsers('TRAINEE')
      .then((list) => {
        setTraineeOptions(list);
        setTraineeError(null);
      })
      .catch((error) => {
        console.error(error);
        setTraineeError("Impossible de charger la liste des apprenants.");
      })
      .finally(() => setTraineeLoading(false));
  }, [sdk]);

  useEffect(() => {
    if (traineeOptions.length === 0) {
      return;
    }
    let storedId: string | null = null;
    try {
      storedId = window.localStorage.getItem('ssi-trainee-user-id');
    } catch (error) {
      console.error(error);
    }
    if (storedId && traineeOptions.some((user) => user.id === storedId)) {
      setSelectedTraineeId(storedId);
      if (!activeTrainee || activeTrainee.id !== storedId) {
        const found = traineeOptions.find((user) => user.id === storedId) ?? null;
        setActiveTrainee(found);
      }
      return;
    }
    if (!selectedTraineeId) {
      setSelectedTraineeId(traineeOptions[0]?.id ?? '');
    }
  }, [activeTrainee, selectedTraineeId, traineeOptions]);

  useEffect(() => {
    if (!activeTrainee || !sessionInfo || sessionInfo.status !== 'active') {
      return;
    }
    if (sessionInfo.trainee?.id === activeTrainee.id) {
      return;
    }
    sdk
      .updateSession(sessionInfo.id, { traineeId: activeTrainee.id })
      .catch((error) => {
        console.error(error);
        setTraineeAuthError("Impossible d'associer l'apprenant à la session en cours.");
      });
  }, [activeTrainee, sdk, sessionInfo?.id, sessionInfo?.status, sessionInfo?.trainee?.id]);

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem('ssi-access-level');
      if (stored) {
        const parsed = Number.parseInt(stored, 10);
        if (parsed === 2) {
          setAccessLevel(2);
          setLedMessage('Niveau 2 actif — commandes avancées disponibles.');
          setAccessLevelExpiryRevision((revision) => revision + 1);
        }
      }
    } catch (error) {
      console.error(error);
    }
  }, []);

  useEffect(() => {
    try {
      window.sessionStorage.setItem('ssi-access-level', String(accessLevel));
    } catch (error) {
      console.error(error);
    }
  }, [accessLevel]);

  const handleAck = useCallback(() => {
    if (accessLevel < 2) return;
    sdk.acknowledgeProcess('trainee').catch(console.error);
  }, [accessLevel, sdk]);

  const handleResetRequest = useCallback(() => {
    if (accessLevel < 2) return;
    if (hasOutstandingManualResets) return;
    sdk.resetSystem().catch(console.error);
  }, [accessLevel, hasOutstandingManualResets, sdk]);

  const handleResetDm = useCallback(
    (zoneId: string) => {
      if (accessLevel < 2) return;
      if (!canResetZone('DM', zoneId)) return;
      sdk.resetManualCallPoint(zoneId).catch(console.error);
    },
    [accessLevel, canResetZone, sdk],
  );

  const handleResetDai = useCallback(
    (zoneId: string) => {
      if (accessLevel < 2) return;
      if (!canResetZone('DAI', zoneId)) return;
      sdk.resetAutomaticDetector(zoneId).catch(console.error);
    },
    [accessLevel, canResetZone, sdk],
  );

  const handleManualEvacToggle = useCallback(() => {
    if (accessLevel < 2) return;
    if (snapshot?.manualEvacuation) {
      sdk.stopManualEvacuation('poste-apprenant').catch(console.error);
    } else {
      sdk.startManualEvacuation('poste-apprenant').catch(console.error);
    }
  }, [accessLevel, sdk, snapshot?.manualEvacuation]);

  const handlePlanDeviceClick = useCallback(
    (device: SiteDevice) => {
      if (device.kind === 'DM' && device.zoneId) {
        if (snapshot?.dmLatched?.[device.zoneId] && canResetZone('DM', device.zoneId)) {
          handleResetDm(device.zoneId);
        }
        return;
      }
      if (device.kind === 'DAI' && device.zoneId) {
        if (snapshot?.daiActivated?.[device.zoneId] && canResetZone('DAI', device.zoneId)) {
          handleResetDai(device.zoneId);
        }
      }
    },
    [canResetZone, handleResetDai, handleResetDm, snapshot],
  );

  const handleSilenceAlarm = useCallback(() => {
    sdk.silenceAudibleAlarm().catch(console.error);
  }, [sdk]);

  const handleAccessDigit = useCallback(
    (digit: string) => {
      if (verifyingAccess) return;
      setCodeBuffer((prev) => (prev.length >= 6 ? prev : `${prev}${digit}`));
    },
    [verifyingAccess],
  );

  const handleAccessClear = useCallback(() => {
    if (verifyingAccess) return;
    setCodeBuffer('');
  }, [verifyingAccess]);

  const handleAccessLock = useCallback(() => {
    setAccessLevel(LOWEST_ACCESS_LEVEL);
    setLedMessage(LOWEST_ACCESS_MESSAGE);
    setCodeBuffer('');
  }, []);

  const handleAccessSubmit = useCallback(async () => {
    if (verifyingAccess) return;
    const input = codeBuffer.trim();
    if (input.length === 0) {
      handleAccessLock();
      return;
    }
    setVerifyingAccess(true);
    setLedMessage('Validation du code en cours…');
    try {
      const result = await sdk.verifyAccessCode(input);
      setLedMessage(result.label);
      if (result.allowed && typeof result.level === 'number') {
        setAccessLevel(result.level);
        if (result.level > LOWEST_ACCESS_LEVEL) {
          setAccessLevelExpiryRevision((revision) => revision + 1);
        }
      }
    } catch (error) {
      console.error(error);
      setLedMessage('Erreur de vérification du code.');
    } finally {
      setVerifyingAccess(false);
      setCodeBuffer('');
    }
  }, [codeBuffer, handleAccessLock, sdk, verifyingAccess]);

  useEffect(() => {
    if (accessLevelResetTimeoutRef.current !== null) {
      window.clearTimeout(accessLevelResetTimeoutRef.current);
      accessLevelResetTimeoutRef.current = null;
    }
    if (accessLevel > LOWEST_ACCESS_LEVEL) {
      accessLevelResetTimeoutRef.current = window.setTimeout(() => {
        accessLevelResetTimeoutRef.current = null;
        handleAccessLock();
      }, ACCESS_LEVEL_AUTO_RESET_DELAY_MS);
    }
    return () => {
      if (accessLevelResetTimeoutRef.current !== null) {
        window.clearTimeout(accessLevelResetTimeoutRef.current);
        accessLevelResetTimeoutRef.current = null;
      }
    };
  }, [accessLevel, accessLevelExpiryRevision, handleAccessLock]);

  const remainingDeadline = snapshot?.cmsi.status === 'EVAC_SUSPENDED'
    ? snapshot.cmsi.remainingMs != null
      ? Math.max(0, Math.floor(snapshot.cmsi.remainingMs / 1000))
      : null
    : snapshot?.cmsi.deadline
    ? Math.max(0, Math.floor((snapshot.cmsi.deadline - now) / 1000))
    : null;

  const anyAudible = Boolean(snapshot?.ugaActive || snapshot?.localAudibleActive);
  const localAudibleOnly = Boolean(snapshot?.localAudibleActive && !snapshot?.ugaActive);
  const scenarioAdaptation = useMemo(
    () => deriveScenarioAdaptation(scenarioUiStatus),
    [scenarioUiStatus],
  );
  const evacuationAudioAsset = useMemo<ScenarioAudioAsset | null>(() => {
    const scenario = scenarioUiStatus.scenario;
    if (!scenario?.evacuationAudio) {
      return null;
    }
    const { automatic, manual } = scenario.evacuationAudio;
    if (snapshot?.manualEvacuation) {
      return manual ?? automatic ?? null;
    }
    if (snapshot?.ugaActive) {
      return automatic ?? manual ?? null;
    }
    return null;
  }, [scenarioUiStatus.scenario, snapshot?.manualEvacuation, snapshot?.ugaActive]);
  useEffect(() => {
    const audioElement = evacuationAudioRef.current;
    if (!audioElement) {
      return;
    }
    const asset = evacuationAudioAsset;
    const shouldPlay = Boolean(asset && (snapshot?.ugaActive || snapshot?.manualEvacuation));
    if (!shouldPlay) {
      if (!audioElement.paused) {
        audioElement.pause();
        audioElement.currentTime = 0;
      }
      if (!asset) {
        audioElement.removeAttribute('src');
      }
      return;
    }
    if (audioElement.src !== asset.dataUrl) {
      audioElement.src = asset.dataUrl;
    }
    audioElement.loop = true;
    if (audioElement.paused) {
      const playPromise = audioElement.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((error) => {
          console.error("Impossible de lire le son d'évacuation.", error);
        });
      }
    }
  }, [evacuationAudioAsset, snapshot?.manualEvacuation, snapshot?.ugaActive]);
  const planName = topology?.plan?.name?.trim() ?? null;
  const planImage = topology?.plan?.image ?? null;
  const zoneDisplayMap = useMemo(() => {
    const map = new Map<string, string>();
    const addZones = (zones?: { id: string; label: string }[]) => {
      zones?.forEach((zone) => {
        const normalizedLabel = zone.label.trim();
        map.set(zone.id, normalizedLabel.length > 0 ? normalizedLabel : zone.id);
      });
    };
    if (topology) {
      addZones(topology.zones);
    }
    if (scenarioUiStatus.scenario?.topology) {
      addZones(scenarioUiStatus.scenario.topology.zones);
    }
    return map;
  }, [scenarioUiStatus.scenario?.topology, topology]);
  const triggeredScenarioEvents = useMemo<TriggeredScenarioEventCard[]>(() => {
    if (scenarioUiStatus.status !== 'running') {
      return [];
    }
    const scenario = scenarioUiStatus.scenario;
    if (!scenario) {
      return [];
    }
    const orderedEvents = [...scenario.events].sort((a, b) => a.offset - b.offset);
    const currentIndex = scenarioUiStatus.currentEventIndex ?? -1;
    if (currentIndex < 0) {
      return [];
    }
    const lastIndex = Math.min(currentIndex, orderedEvents.length - 1);
    if (lastIndex < 0) {
      return [];
    }
    const activeCards: TriggeredScenarioEventCard[] = [];
    for (let index = 0; index <= lastIndex; index += 1) {
      const event = orderedEvents[index];
      if (!isScenarioEventActive(event, snapshot)) {
        continue;
      }
      const zoneId = 'zoneId' in event ? event.zoneId : null;
      const zoneName = zoneId ? zoneDisplayMap.get(zoneId) ?? zoneId : null;
      const zoneDisplay = zoneId
        ? zoneName && zoneName !== zoneId
          ? `${zoneId} · ${zoneName}`
          : zoneId
        : 'Action globale';
      activeCards.push({
        id: event.id ?? `${index}-${event.type}-${zoneId ?? 'none'}-${event.offset}`,
        label: describeScenarioStep(event),
        zoneDisplay,
        offsetLabel: formatScenarioOffset(event.offset),
        tone: getScenarioEventTone(event),
      });
    }
    return activeCards;
  }, [scenarioUiStatus, snapshot, zoneDisplayMap]);

  const handleTraineeSelectChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setSelectedTraineeId(event.target.value);
    setTraineeAuthError(null);
  }, []);

  const handleTraineeLogin = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!selectedTraineeId) {
        setTraineeAuthError('Sélectionnez un compte apprenant.');
        return;
      }
      const trainee = traineeOptions.find((user) => user.id === selectedTraineeId);
      if (!trainee) {
        setTraineeAuthError('Compte apprenant introuvable.');
        return;
      }
      setTraineeAuthPending(true);
      setTraineeAuthError(null);
      try {
        setActiveTrainee(trainee);
        try {
          window.localStorage.setItem('ssi-trainee-user-id', trainee.id);
        } catch (storageError) {
          console.error(storageError);
        }
        if (sessionInfo && sessionInfo.status === 'active' && sessionInfo.trainee?.id !== trainee.id) {
          await sdk.updateSession(sessionInfo.id, { traineeId: trainee.id });
        }
      } catch (error) {
        console.error(error);
        setTraineeAuthError("Impossible de valider l'identification.");
      } finally {
        setTraineeAuthPending(false);
      }
    },
    [sdk, selectedTraineeId, sessionInfo?.id, sessionInfo?.status, sessionInfo?.trainee?.id, traineeOptions],
  );

  const handleTraineeLogout = useCallback(() => {
    setActiveTrainee(null);
    try {
      window.localStorage.removeItem('ssi-trainee-user-id');
    } catch (error) {
      console.error(error);
    }
    if (sessionInfo && sessionInfo.status === 'active' && sessionInfo.trainee) {
      sdk
        .updateSession(sessionInfo.id, { traineeId: null })
        .catch((error) => {
          console.error(error);
          setTraineeAuthError("Impossible de dissocier l'apprenant de la session en cours.");
        });
    }
  }, [sdk, sessionInfo?.id, sessionInfo?.status, sessionInfo?.trainee]);

  const boardModules: BoardModule[] = useMemo(() => {
    const daiCount = Object.keys(snapshot?.daiActivated ?? {}).length;
    const dmModules: BoardModule[] = (() => {
      if (!topology) {
        return Array.from({ length: 8 }, (_, index) => {
          const zone = `ZF${index + 1}`;
          const isLatched = Boolean(snapshot?.dmLatched?.[zone]);
          return {
            id: `dm-${zone.toLowerCase()}`,
            label: zone,
            description: `Déclencheur manuel ${zone}`,
            tone: 'warning',
            active: isLatched,
            highlighted: scenarioAdaptation.boardHighlights.has(`dm-${zone.toLowerCase()}`),
          };
        });
      }

      const zoneLabels = new Map(topology.zones.map((zone) => [zone.id, zone.label]));
      const dmZoneIds = new Set<string>();
      topology.devices.forEach((device) => {
        if (device.kind === 'DM' && device.zoneId) {
          dmZoneIds.add(device.zoneId);
        }
      });

      if (dmZoneIds.size === 0) {
        return [];
      }

      return Array.from(dmZoneIds)
        .sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }))
        .map((zoneId) => {
          const label = zoneLabels.get(zoneId) ?? zoneId;
          const description = label && label !== zoneId
            ? `Déclencheur manuel ${label}`
            : `Déclencheur manuel ${zoneId}`;
          return {
            id: `dm-${zoneId.toLowerCase()}`,
            label: zoneId,
            description,
            tone: 'warning' as const,
            active: Boolean(snapshot?.dmLatched?.[zoneId]),
            highlighted: scenarioAdaptation.boardHighlights.has(`dm-${zoneId.toLowerCase()}`),
          };
        });
    })();

    return [
      {
        id: 'cmsi-status',
        label: 'CMSI',
        description: cmsiStatusLabel[snapshot?.cmsi.status ?? ''] ?? 'Système normal',
        tone: cmsiStatusTone[snapshot?.cmsi.status ?? ''] ?? 'info',
        active: Boolean(snapshot?.cmsi.status && snapshot.cmsi.status !== 'IDLE'),
        highlighted: scenarioAdaptation.boardHighlights.has('cmsi-status'),
      },
      {
        id: 'uga',
        label: 'UGA',
        description: snapshot?.ugaActive
          ? 'Alarme générale sonore'
          : localAudibleOnly
          ? 'Signal sonore local CMSI'
          : 'Alarme générale sonore',
        tone: snapshot?.ugaActive ? 'alarm' : localAudibleOnly ? 'warning' : 'info',
        active: anyAudible,
        highlighted: scenarioAdaptation.boardHighlights.has('uga'),
      },
      {
        id: 'das',
        label: 'DAS',
        description: 'Dispositifs actionnés de sécurité',
        tone: 'warning',
        active: Boolean(snapshot?.dasApplied),
        highlighted: scenarioAdaptation.boardHighlights.has('das'),
      },
      {
        id: 'manual-evac',
        label: 'Manuel',
        description: 'Commande manuelle évacuation',
        tone: 'info',
        active: Boolean(snapshot?.manualEvacuation),
        highlighted: scenarioAdaptation.boardHighlights.has('manual-evac'),
      },
      {
        id: 'dai',
        label: 'DAI',
        description:
          daiCount > 0
            ? `${daiCount} alarme(s) feu non soumise(s) à l'évacuation`
            : 'Détection automatique incendie',
        tone: daiCount > 0 ? 'warning' : 'info',
        active: daiCount > 0,
        highlighted: scenarioAdaptation.boardHighlights.has('dai'),
      },
      ...dmModules,
    ];
  }, [
    snapshot,
    anyAudible,
    localAudibleOnly,
    scenarioAdaptation.boardHighlights,
    topology,
  ]);

  const orderedBoardModules = useMemo(
    () => orderItems(boardModules, layout.boardModuleOrder, layout.boardModuleHidden ?? []),
    [boardModules, layout.boardModuleOrder, layout.boardModuleHidden],
  );

  const scenarioStatusLabel = translateScenarioStatus(
    scenarioStatus.status,
    scenarioStatus.awaitingSystemReset,
  );
  const nextScenarioEvent = describeScenarioEvent(scenarioUiStatus);

  const cmsiMode = snapshot?.cmsi.manual ? 'Mode manuel' : 'Mode automatique';
  const scenarioDescription = scenarioAdaptation.description;
  const hasScenarioGuidance = Boolean(
    scenarioUiStatus.scenario && (scenarioDescription || scenarioAdaptation.steps.length > 0),
  );

  const resetDmZf1Allowed = canResetZone('DM', 'ZF1');

  const controlButtons: ControlButtonItem[] = [
    {
      id: 'silence',
      label: 'Arrêt signal sonore',
      tone: 'red',
      onClick: handleSilenceAlarm,
      disabled: !anyAudible,
      title: !anyAudible ? 'Aucun signal sonore en cours' : undefined,
    },
    {
      id: 'ack',
      label: 'Acquittement',
      tone: 'amber',
      onClick: handleAck,
      disabled: accessLevel < 2,
      title: accessLevel < 2 ? 'Code niveau 2 requis' : undefined,
    },
    {
      id: 'reset-request',
      label: 'Demande de réarmement',
      tone: 'blue',
      onClick: handleResetRequest,
      disabled: accessLevel < 2 || hasOutstandingManualResets,
      title:
        accessLevel < 2
          ? 'Code niveau 2 requis'
          : hasOutstandingManualResets
          ? 'Réarmez les dispositifs requis avant de demander la remise à zéro'
          : undefined,
    },
    {
      id: 'reset-dm-zf1',
      label: 'Réarmement DM ZF1',
      tone: 'green',
      onClick: () => handleResetDm('ZF1'),
      disabled: accessLevel < 2 || !resetDmZf1Allowed,
      title:
        accessLevel < 2
          ? 'Code niveau 2 requis'
          : !resetDmZf1Allowed
          ? 'Réarmement manuel non autorisé par le scénario'
          : undefined,
    },
    {
      id: 'manual-evac-toggle',
      label: snapshot?.manualEvacuation ? 'Arrêt évacuation manuelle' : 'Déclencher évacuation manuelle',
      tone: snapshot?.manualEvacuation ? 'blue' : 'purple',
      onClick: handleManualEvacToggle,
      disabled: accessLevel < 2,
      title: accessLevel < 2 ? 'Code niveau 2 requis' : undefined,
    },
  ];

  const decoratedControlButtons = controlButtons.map((button) => ({
    ...button,
    highlighted: scenarioAdaptation.controlHighlights.has(button.id),
  }));

  const orderedControlButtons = orderItems(
    decoratedControlButtons,
    layout.controlButtonOrder,
    layout.controlButtonHidden ?? [],
  );

  const sidePanelItems: SidePanelItem[] = [
    {
      id: 'access-control',
      element: (
        <AccessControlPanel
          accessLevel={accessLevel}
          ledMessage={ledMessage}
          codeBuffer={codeBuffer}
          verifying={verifyingAccess}
          onDigit={handleAccessDigit}
          onClear={handleAccessClear}
          onSubmit={handleAccessSubmit}
          onLock={handleAccessLock}
        />
      ),
    },
    {
      id: 'training-session',
      element: (
        <article className="detail-panel session-panel">
          <h3 className="detail-title">Session de formation</h3>
          {sessionInfo ? (
            <div className="session-panel__content">
              <div className={`session-panel__status session-panel__status--${sessionInfo.status}`}>
                {sessionInfo.status === 'active' ? 'En cours' : 'Clôturée'}
              </div>
              <h4 className="session-panel__name">{sessionInfo.name}</h4>
              <dl className="session-panel__meta">
                <div>
                  <dt>Apprenant</dt>
                  <dd>{sessionInfo.trainee?.fullName ?? 'Non attribué'}</dd>
                </div>
                <div>
                  <dt>Formateur</dt>
                  <dd>{sessionInfo.trainer?.fullName ?? '—'}</dd>
                </div>
                <div>
                  <dt>Début</dt>
                  <dd>{formatDateTime(sessionInfo.startedAt)}</dd>
                </div>
                {sessionInfo.endedAt && (
                  <div>
                    <dt>Fin</dt>
                    <dd>{formatDateTime(sessionInfo.endedAt)}</dd>
                  </div>
                )}
              </dl>
              {sessionInfo.objective && (
                <div className="session-panel__objective">
                  <span>Objectifs</span>
                  <p>{sessionInfo.objective}</p>
                </div>
              )}
              {improvementAreas.length > 0 ? (
                <div className="session-panel__improvements">
                  <span>Axes d'amélioration</span>
                  <ul>
                    {improvementAreas.map((area, index) => (
                      <li key={`${area.title}-${index}`}>
                        <strong>{area.title}</strong>
                        {area.description && <span> — {area.description}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="session-panel__placeholder">
                  Les axes d'amélioration personnalisés apparaîtront après la clôture de la session.
                </p>
              )}
            </div>
          ) : (
            <p className="session-panel__placeholder">
              En attente d'une session attribuée par le formateur.
            </p>
          )}
        </article>
      ),
    },
    {
      id: 'event-recap',
      element: (
        <article className="detail-panel">
          <h3 className="detail-title">Récapitulatif évènementiel</h3>
          <ul className="detail-list">
            <li>
              <span className="detail-label">Processus</span>
              <span className="detail-value">{snapshot?.processAck?.isAcked ? 'Acquitté' : 'En attente'}</span>
            </li>
            <li>
              <span className="detail-label">Suspension</span>
              <span className="detail-value">
                {snapshot?.cmsi.status === 'EVAC_SUSPENDED'
                  ? remainingDeadline != null
                    ? `Active (${remainingDeadline}s restantes)`
                    : 'Active'
                  : 'Inactive'}
              </span>
            </li>
            <li>
              <span className="detail-label">Signal sonore</span>
              <span className="detail-value">
                {snapshot?.ugaActive
                  ? 'Alarme générale'
                  : snapshot?.localAudibleActive
                  ? 'Signal local CMSI'
                  : 'Arrêté'}
              </span>
            </li>
            <li>
              <span className="detail-label">DAS</span>
              <span className="detail-value">{snapshot?.dasApplied ? 'Appliqués' : 'Repos'}</span>
            </li>
            <li>
              <span className="detail-label">Déclenchements DM</span>
              <span className="detail-value">{Object.keys(snapshot?.dmLatched ?? {}).length}</span>
            </li>
            <li>
              <span className="detail-label">Détections DAI</span>
              <span className="detail-value">{Object.keys(snapshot?.daiActivated ?? {}).length}</span>
            </li>
            <li>
              <span className="detail-label">Scénario</span>
              <span className="detail-value">
                {scenarioUiStatus.scenario?.name
                  ? `${scenarioUiStatus.scenario.name} (${scenarioStatusLabel})`
                  : scenarioStatusLabel}
              </span>
            </li>
            <li>
              <span className="detail-label">Prochain événement</span>
              <span className="detail-value">{nextScenarioEvent}</span>
            </li>
          </ul>
        </article>
      ),
    },
    {
      id: 'instructions',
      element: (
        <article className={`detail-panel ${hasScenarioGuidance ? 'detail-panel--highlighted' : ''}`}>
          <h3 className="detail-title">Consignes Apprenant</h3>
          {hasScenarioGuidance ? (
            <>
              <div className="scenario-guidance">
                <span className="scenario-guidance__label">Scénario actif</span>
                <span className="scenario-guidance__name">{scenarioUiStatus.scenario?.name}</span>
              </div>
              {scenarioDescription && <p className="instruction-text">{scenarioDescription}</p>}
              {scenarioAdaptation.steps.length > 0 && (
                <ol className="instruction-timeline">
                  {scenarioAdaptation.steps.map((step) => (
                    <li
                      key={step.id}
                      className={`instruction-step${step.completed ? ' is-completed' : ''}${
                        step.isNext ? ' is-next' : ''
                      }`}
                      aria-current={step.isNext ? 'step' : undefined}
                    >
                      {step.label}
                    </li>
                  ))}
                </ol>
              )}
              {planNotes.length > 0 && (
                <div className="plan-notes">
                  <h4 className="plan-notes__title">Repères site</h4>
                  <ul className="instruction-list">
                    {planNotes.map((note) => (
                      <li key={note} className="instruction-text">
                        {note}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : planNotes.length > 0 ? (
            <ul className="instruction-list">
              {planNotes.map((note) => (
                <li key={note} className="instruction-text">
                  {note}
                </li>
              ))}
            </ul>
          ) : (
            <>
              <p className="instruction-text">
                Surveillez l&apos;évolution du synoptique, vérifiez les zones en alarme et appliquez la procédure
                d&apos;acquittement avant de réarmer le système. Utilisez les boutons du bandeau de commande pour
                reproduire fidèlement les actions terrain.
              </p>
              <p className="instruction-text">
                Lorsque plusieurs déclencheurs manuels sont actifs, procédez au réarmement zone par zone afin
                d&apos;observer les retours d&apos;information dans le tableau répétiteur.
              </p>
            </>
          )}
        </article>
      ),
    },
  ];

  const orderedSidePanels = orderItems(
    sidePanelItems,
    layout.sidePanelOrder,
    layout.sidePanelHidden ?? [],
  );

  return (
    <div className="trainee-shell">
      <audio ref={evacuationAudioRef} aria-hidden="true" preload="auto" style={{ display: 'none' }} />
      <header className="trainee-header">
        <div className="header-identification">
          <div className="header-titles">
            <span className="brand">Logiciel de simulation SSI</span>
            <h1 className="title">Poste Apprenant – Façade CMSI</h1>
          </div>
          <div className={`scenario-chip scenario-chip--${scenarioStatus.status}`}>
            {scenarioUiStatus.scenario?.name ?? 'Scénario libre'} · {scenarioStatusLabel}
          </div>
        </div>
        <div className="header-actions">
          <div className="header-auth">
            <div className="header-auth__status">
              <span className="header-auth__label">Apprenant connecté</span>
              <span className="header-auth__value">{activeTrainee?.fullName ?? 'Aucun'}</span>
            </div>
            <form className="auth-form" onSubmit={handleTraineeLogin}>
              <label className="auth-form__field">
                <span>Choisir un compte</span>
                <select
                  className="auth-select"
                  value={selectedTraineeId}
                  onChange={handleTraineeSelectChange}
                  disabled={traineeLoading || traineeOptions.length === 0}
                >
                  {traineeOptions.length === 0 ? (
                    <option value="">Aucun compte disponible</option>
                  ) : (
                    traineeOptions.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.fullName}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <div className="auth-form__actions">
                <button type="submit" className="btn-auth" disabled={traineeAuthPending || traineeOptions.length === 0}>
                  {traineeAuthPending ? 'Identification…' : 'S\'identifier'}
                </button>
                {activeTrainee && (
                  <button
                    type="button"
                    className="btn-auth btn-auth--secondary"
                    onClick={handleTraineeLogout}
                  >
                    Se déconnecter
                  </button>
                )}
              </div>
            </form>
            {traineeAuthError && <p className="header-auth__error">{traineeAuthError}</p>}
            {traineeError && <p className="header-auth__error">{traineeError}</p>}
          </div>
          <div className="header-status">
            <StatusBadge
              tone={cmsiStatusTone[snapshot?.cmsi.status ?? ''] ?? 'info'}
              label={cmsiStatusLabel[snapshot?.cmsi.status ?? ''] ?? 'Système normal'}
            />
            <div className="timer-box">
              <span className="timer-label">Échéance T+5</span>
              <span className="timer-value">{remainingDeadline !== null ? `${remainingDeadline}s` : '—'}</span>
            </div>
          </div>
        </div>
      </header>
      <main className="trainee-main">
        <section className="synoptic-panel">
          <header className="panel-header">
            <div>
              <h2 className="panel-title">Synoptique CMSI</h2>
              <p className="panel-subtitle">Visualisation des zones et actionneurs</p>
            </div>
            <div className="panel-mode">{cmsiMode}</div>
          </header>
          <div className="synoptic-board">
            {orderedBoardModules.map((module) => (
              <BoardTile key={module.id} module={module} />
            ))}
          </div>
          <div className="control-strip">
            {orderedControlButtons.map((button) => (
              <ControlButton
                key={button.id}
                label={button.label}
                tone={button.tone}
                onClick={button.onClick}
                disabled={button.disabled}
                title={button.title}
                highlighted={button.highlighted}
              />
            ))}
          </div>
          {planImage && (
            <div className="floor-plan" aria-label="Plan interactif du site">
              <div className="floor-plan__header">
                <div>
                  <h3 className="floor-plan__title">Plan du site</h3>
                  {planName && <p className="floor-plan__subtitle">{planName}</p>}
                </div>
                <p className="floor-plan__hint">
                  {accessLevel >= 2
                    ? 'Cliquez sur un DM ou une DAI active pour les réarmer.'
                    : 'Passez au niveau 2 pour réarmer depuis le plan.'}
                </p>
              </div>
              <div className="floor-plan__stage">
                <img src={planImage} alt={planName ? `Plan ${planName}` : 'Plan du site'} />
                {topology?.devices.map((device) => {
                  const position = getDevicePosition(device);
                  if (!position) {
                    return null;
                  }
                  const markerLabel = DEVICE_MARKER_LABELS[device.kind] ?? device.kind;
                  const deviceLabel = device.label?.trim().length ? device.label.trim() : device.id;
                  const zoneLabel = device.zoneId ? ` (${device.zoneId})` : '';
                  const active = isDeviceActive(device, snapshot);
                  const actionable = isDeviceActionable(
                    device,
                    snapshot,
                    accessLevel,
                    manualResetConstraints,
                  );
                  const className = [
                    'floor-plan__marker',
                    `floor-plan__marker--${device.kind.toLowerCase()}`,
                    active ? 'is-active' : '',
                    actionable ? 'is-actionable' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  const title = `${markerLabel} · ${deviceLabel}${zoneLabel}`;
                  return (
                    <button
                      key={device.id}
                      type="button"
                      className={className}
                      style={{ left: `${position.x}%`, top: `${position.y}%` }}
                      onClick={() => handlePlanDeviceClick(device)}
                      title={title}
                      aria-label={title}
                      disabled={!actionable}
                    >
                      {markerLabel}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {triggeredScenarioEvents.length > 0 && (
            <div className="scenario-event-feed" aria-live="polite">
              {triggeredScenarioEvents.map((event) => (
                <article
                  key={event.id}
                  className={`scenario-event-card scenario-event-card--${event.tone}`}
                >
                  <div className="scenario-event-card__meta">
                    <span className="scenario-event-card__zone">Zone : {event.zoneDisplay}</span>
                    {event.offsetLabel && (
                      <span className="scenario-event-card__badge">{event.offsetLabel}</span>
                    )}
                  </div>
                  <p className="scenario-event-card__label">{event.label}</p>
                </article>
              ))}
            </div>
          )}
        </section>
        <section className="side-panels">
          {orderedSidePanels.map((panel) => (
            <Fragment key={panel.id}>{panel.element}</Fragment>
          ))}
        </section>
      </main>
      <footer className="trainee-footer">
        <span>Raccourcis clavier : Ctrl+M déclenchement — Ctrl+Shift+M arrêt.</span>
        <span>Version pédagogique — poste apprenant</span>
      </footer>
    </div>
  );
}

interface StatusBadgeProps {
  label: string;
  tone: BoardModuleTone;
}

function StatusBadge({ label, tone }: StatusBadgeProps) {
  return <div className={`status-badge status-${tone}`}>{label}</div>;
}

interface ControlButtonProps {
  label: string;
  tone: 'amber' | 'blue' | 'green' | 'red' | 'purple';
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  highlighted?: boolean;
}

interface ControlButtonItem extends ControlButtonProps {
  id: string;
}

function ControlButton({ label, tone, onClick, disabled, title, highlighted }: ControlButtonProps) {
  return (
    <button
      type="button"
      className={`control-button control-${tone} ${highlighted ? 'is-highlighted' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {label}
    </button>
  );
}

interface BoardTileProps {
  module: BoardModule;
}

function BoardTile({ module }: BoardTileProps) {
  return (
    <div
      className={`board-tile tone-${module.tone} ${module.active ? 'is-active' : ''} ${
        module.highlighted ? 'is-highlighted' : ''
      }`}
    >
      <div className="tile-header">
        <span className="tile-label">{module.label}</span>
        <span className="tile-led" aria-hidden />
      </div>
      <p className="tile-description">{module.description}</p>
    </div>
  );
}

interface AccessControlPanelProps {
  accessLevel: number;
  ledMessage: string;
  codeBuffer: string;
  verifying: boolean;
  onDigit: (digit: string) => void;
  onClear: () => void;
  onSubmit: () => void;
  onLock: () => void;
}

interface SidePanelItem {
  id: string;
  element: JSX.Element;
}

function AccessControlPanel({
  accessLevel,
  ledMessage,
  codeBuffer,
  verifying,
  onDigit,
  onClear,
  onSubmit,
  onLock,
}: AccessControlPanelProps) {
  return (
    <article className="detail-panel access-panel">
      <div className="access-panel__header">
        <h3 className="detail-title">Contrôle d&apos;accès SSI</h3>
        <button type="button" className="access-panel__lock" onClick={onLock}>
          Retour niveau 1
        </button>
      </div>
      <div className="led-screen" aria-live="polite">
        <span className="led-screen__level">Niveau {accessLevel}</span>
        <span className="led-screen__message">{ledMessage}</span>
        {verifying && <span className="led-screen__status">Validation du code…</span>}
      </div>
      <NumericKeypad
        codeBuffer={codeBuffer}
        disabled={verifying}
        onDigit={onDigit}
        onClear={onClear}
        onSubmit={onSubmit}
      />
      <p className="access-panel__hint">
        Sans code : arrêt signal sonore uniquement. Un code niveau 2 débloque les acquits, réarmements, mises hors service et
        évacuations manuelles. Le niveau 3 reste réservé au technicien de maintenance.
      </p>
    </article>
  );
}

interface NumericKeypadProps {
  codeBuffer: string;
  disabled: boolean;
  onDigit: (digit: string) => void;
  onClear: () => void;
  onSubmit: () => void;
}

function NumericKeypad({ codeBuffer, disabled, onDigit, onClear, onSubmit }: NumericKeypadProps) {
  const masked = codeBuffer.length > 0 ? '●'.repeat(codeBuffer.length) : '—';
  const layout = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK'];
  return (
    <div className="keypad">
      <div className="keypad__display" aria-live="polite">
        {masked}
      </div>
      <div className="keypad__grid">
        {layout.map((key) => {
          if (key === 'C') {
            return (
              <button
                key={key}
                type="button"
                className="keypad__key keypad__key--action"
                onClick={onClear}
                disabled={disabled}
              >
                Effacer
              </button>
            );
          }
          if (key === 'OK') {
            return (
              <button
                key={key}
                type="button"
                className="keypad__key keypad__key--confirm"
                onClick={onSubmit}
                disabled={disabled}
              >
                Valider
              </button>
            );
          }
          return (
            <button
              key={key}
              type="button"
              className="keypad__key"
              onClick={() => onDigit(key)}
              disabled={disabled}
            >
              {key}
            </button>
          );
        })}
      </div>
    </div>
  );
}
