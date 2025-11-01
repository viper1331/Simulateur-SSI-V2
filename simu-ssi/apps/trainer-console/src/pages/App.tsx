import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { io } from 'socket.io-client';
import { ManualEvacuationPanel, StatusTile, TimelineBadge } from '@simu-ssi/shared-ui';
import {
  SsiSdk,
  DEFAULT_TRAINEE_LAYOUT,
  type AccessCode,
  type SessionSummary,
  type SessionImprovement,
  type UserImportPayload,
  type UserImportResult,
  type UserRole,
  type UserSummary,
  type ScenarioDefinition,
  type ScenarioEvent,
  type ScenarioManualResetSelection,
  type ScenarioPayload,
  type ScenarioEvacuationAudio,
  type ScenarioAudioAsset,
  scenarioDefinitionSchema,
  scenarioPayloadSchema,
  type ScenarioRunnerSnapshot,
  type SiteConfig,
  type SiteDevice,
  type SiteTopology,
  sessionSchema,
  siteTopologySchema,
  traineeLayoutSchema,
  type TraineeLayoutConfig,
} from '@simu-ssi/sdk';

interface CmsiStateData {
  status: string;
  deadline?: number;
  manual?: boolean;
  remainingMs?: number;
  startedAt?: number;
  zoneId?: string;
}

interface DomainSnapshot {
  cmsi: CmsiStateData;
  ugaActive: boolean;
  localAudibleActive: boolean;
  dasApplied: boolean;
  manualEvacuation: boolean;
  manualEvacuationReason?: string;
  processAck: { isAcked: boolean };
  dmLatched: Record<string, { zoneId: string; lastActivatedAt?: number }>;
  daiActivated: Record<string, { zoneId: string; lastActivatedAt?: number; lastResetAt?: number }>;
}

type ScenarioEventDraft = ScenarioEvent & { id: string };

interface ScenarioDraft {
  id?: string;
  name: string;
  description?: string;
  topology: SiteTopology | null;
  events: ScenarioEventDraft[];
  manualResetMode: 'all' | 'custom';
  manualResettable: ScenarioManualResetSelection;
  evacuationAudio?: ScenarioEvacuationAudio;
}

const CMSI_STATUS_LABELS: Record<string, string> = {
  IDLE: 'Repos',
  SAFE_HOLD: 'Maintien',
  EVAC_PENDING: 'Pré-alerte',
  EVAC_ACTIVE: 'Evacuation',
  EVAC_SUSPENDED: 'Suspendue',
};

const ZONE_KIND_LABELS: Record<string, string> = {
  ZF: 'Zone de Fonctionnement',
  ZD: 'Zone de Détection',
  ZS: 'Zone de Sécurité',
};

const DEVICE_KIND_LABELS: Record<string, string> = {
  DM: 'DM',
  DAI: 'DAI',
  DAS: 'DAS',
  UGA: 'UGA',
};

const UNASSIGNED_ZONE_KEY = '__UNASSIGNED__';

const BOARD_TILE_LABELS: Record<string, string> = {
  'cmsi-status': 'CMSI – état général',
  uga: 'UGA – diffusion sonore',
  das: 'DAS – actionneurs',
  'manual-evac': 'Commande évacuation manuelle',
  dai: 'DAI – détection auto',
  'out-of-service': 'Dispositifs hors service',
};

for (let index = 1; index <= 8; index += 1) {
  BOARD_TILE_LABELS[`dm-zf${index}`] = `DM ZF${index}`;
}

const CONTROL_BUTTON_LABELS: Record<string, string> = {
  silence: 'Arrêt signal sonore',
  ack: 'Acquittement Process',
  'reset-request': 'Demande de réarmement',
  'reset-dm-zf1': 'Réarmement DM ZF1',
  'manual-evac-toggle': 'Commande évacuation manuelle',
};

const SIDE_PANEL_LABELS: Record<string, string> = {
  'access-control': "Clavier d'accès et niveaux",
  'event-recap': 'Récapitulatif évènementiel',
  'training-session': 'Session de formation',
  instructions: 'Consignes Apprenant',
};

const NAVIGATION_SECTIONS = [
  { id: 'overview', label: "Vue d'ensemble" },
  { id: 'operations', label: 'Opérations en direct' },
  { id: 'configuration', label: 'Paramètres & accès' },
  { id: 'trainee', label: 'Poste apprenant' },
  { id: 'topology', label: 'Cartographie' },
  { id: 'scenarios', label: 'Scénarios pédagogiques' },
  { id: 'sessions', label: 'Sessions & apprenants' },
  { id: 'journal', label: "Journal d'événements" },
] as const;

type SectionId = (typeof NAVIGATION_SECTIONS)[number]['id'];

const BOARD_BASELINE = DEFAULT_TRAINEE_LAYOUT.boardModuleOrder;
const CONTROL_BASELINE = DEFAULT_TRAINEE_LAYOUT.controlButtonOrder;
const PANEL_BASELINE = DEFAULT_TRAINEE_LAYOUT.sidePanelOrder;

function sortByBaseline(ids: string[], baseline: string[]): string[] {
  const index = new Map(baseline.map((id, orderIndex) => [id, orderIndex]));
  return Array.from(new Set(ids)).sort((a, b) => {
    const aIndex = index.get(a) ?? baseline.length;
    const bIndex = index.get(b) ?? baseline.length;
    return aIndex - bIndex;
  });
}

function cloneLayout(layout: TraineeLayoutConfig): TraineeLayoutConfig {
  return {
    boardModuleOrder: [...layout.boardModuleOrder],
    boardModuleHidden: sortByBaseline(layout.boardModuleHidden ?? [], BOARD_BASELINE),
    controlButtonOrder: [...layout.controlButtonOrder],
    controlButtonHidden: sortByBaseline(layout.controlButtonHidden ?? [], CONTROL_BASELINE),
    sidePanelOrder: [...layout.sidePanelOrder],
    sidePanelHidden: sortByBaseline(layout.sidePanelHidden ?? [], PANEL_BASELINE),
  };
}

function cloneTopology(topology: SiteTopology): SiteTopology {
  return JSON.parse(JSON.stringify(topology)) as SiteTopology;
}

function formatCmsiStatus(status?: string) {
  if (!status) return '—';
  return CMSI_STATUS_LABELS[status] ?? status;
}

function formatTime(iso?: number) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString();
}

function translateScenarioStatus(
  status: ScenarioRunnerSnapshot['status'],
  awaitingSystemReset?: boolean,
): string {
  if (status === 'running' && awaitingSystemReset) {
    return 'En attente de réarmement';
  }
  switch (status) {
    case 'running':
      return 'En cours';
    case 'ready':
      return 'Préchargé';
    case 'completed':
      return 'Terminé';
    case 'stopped':
      return 'Interrompu';
    default:
      return 'Disponible';
  }
}

function describeScenarioEvent(snapshot: ScenarioRunnerSnapshot): string {
  if (snapshot.awaitingSystemReset) {
    return 'Attente du réarmement du système';
  }
  const event = snapshot.nextEvent;
  if (!event) {
    return '—';
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
      return 'Début évacuation manuelle';
    case 'MANUAL_EVAC_STOP':
      return 'Fin évacuation manuelle';
    case 'PROCESS_ACK':
      return `Acquit process (${event.ackedBy ?? 'formateur'})`;
    case 'PROCESS_CLEAR':
      return "Nettoyage de l'acquit";
    case 'SYSTEM_RESET':
      return 'Demande de reset système';
    default:
      return 'Action scénario';
  }
}

function formatZoneKind(kind?: string) {
  if (!kind) {
    return 'Type non défini';
  }
  return ZONE_KIND_LABELS[kind] ?? kind;
}

function formatDeviceKind(kind: string) {
  return DEVICE_KIND_LABELS[kind] ?? kind;
}

function resolveDeviceLabel(device: SiteDevice) {
  return device.label?.trim().length ? device.label : device.id;
}

function extractDeviceCoords(device: SiteDevice): string | null {
  const props = device.props as Record<string, unknown> | undefined;
  if (!props) {
    return null;
  }
  const coordinates = props.coordinates as { xPercent?: number; yPercent?: number } | undefined;
  const xValue = typeof props.x === 'number' ? props.x : coordinates?.xPercent;
  const yValue = typeof props.y === 'number' ? props.y : coordinates?.yPercent;
  const x = typeof xValue === 'number' ? Math.round(xValue) : null;
  const y = typeof yValue === 'number' ? Math.round(yValue) : null;
  if (x === null || y === null) {
    return null;
  }
  return `${x} × ${y}`;
}

function deviceBadgeClass(kind: string) {
  return `topology-device__badge topology-device__badge--${kind.toLowerCase()}`;
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

function extractPlanMetadata(topology: SiteTopology | null): { planName: string | null; notes: string[] } {
  if (!topology) {
    return { planName: null, notes: [] };
  }
  let planName: string | null = null;
  const notes = new Set<string>();

  if (topology.plan?.name && topology.plan.name.trim().length > 0) {
    planName = topology.plan.name.trim();
  }
  for (const note of splitPlanNotes(topology.plan?.notes)) {
    notes.add(note);
  }

  for (const device of topology.devices) {
    if (!planName) {
      const props = device.props as Record<string, unknown> | undefined;
      const rawName = props?.planName;
      if (!planName && typeof rawName === 'string' && rawName.trim().length > 0) {
        planName = rawName.trim();
      }
      const rawNotes = props?.planNotes;
      if (typeof rawNotes === 'string') {
        for (const line of splitPlanNotes(rawNotes)) {
          notes.add(line);
        }
      }
    } else {
      const props = device.props as Record<string, unknown> | undefined;
      const rawNotes = props?.planNotes;
      if (typeof rawNotes === 'string') {
        for (const line of splitPlanNotes(rawNotes)) {
          notes.add(line);
        }
      }
    }
  }

  return { planName, notes: Array.from(notes) };
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

function isDeviceActive(device: SiteDevice, snapshot: DomainSnapshot | null): boolean {
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

function createEmptyManualResetSelection(): ScenarioManualResetSelection {
  return { dmZones: [], daiZones: [] };
}

function normalizeManualResetSelection(
  selection?: ScenarioManualResetSelection | null,
): ScenarioManualResetSelection {
  const normalizeList = (zones?: string[]) =>
    Array.from(
      new Set(
        (zones ?? [])
          .map((zone) => zone.trim().toUpperCase())
          .filter((zone) => zone.length > 0),
      ),
    );
  const source = selection ?? createEmptyManualResetSelection();
  return {
    dmZones: normalizeList(source.dmZones),
    daiZones: normalizeList(source.daiZones),
  };
}

function sanitizeAudioAsset(asset?: ScenarioAudioAsset | null): ScenarioAudioAsset | undefined {
  if (!asset) {
    return undefined;
  }
  const name = asset.name?.trim();
  const dataUrl = asset.dataUrl?.toString().trim();
  if (!name || !dataUrl) {
    return undefined;
  }
  return { name, dataUrl };
}

function normalizeEvacuationAudio(
  audio?: ScenarioEvacuationAudio | null,
): ScenarioEvacuationAudio | undefined {
  if (!audio) {
    return undefined;
  }
  const automatic = sanitizeAudioAsset(audio.automatic);
  const manual = sanitizeAudioAsset(audio.manual);
  if (!automatic && !manual) {
    return undefined;
  }
  return { ...(automatic ? { automatic } : {}), ...(manual ? { manual } : {}) };
}

function createEmptyScenarioDraft(): ScenarioDraft {
  return {
    name: '',
    description: '',
    topology: null,
    events: [],
    manualResetMode: 'all',
    manualResettable: createEmptyManualResetSelection(),
    evacuationAudio: undefined,
  };
}

function ensureDraftEvent(event: ScenarioEvent): ScenarioEventDraft {
  const id = event.id ?? crypto.randomUUID();
  return { ...event, id } as ScenarioEventDraft;
}

function createDraftEvent(type: ScenarioEvent['type'], defaultZoneId?: string): ScenarioEventDraft {
  const id = crypto.randomUUID();
  const base = { id, offset: 0, label: '' as string | undefined };
  switch (type) {
    case 'DM_TRIGGER':
    case 'DM_RESET':
    case 'DAI_TRIGGER':
    case 'DAI_RESET':
      return { ...base, type, zoneId: (defaultZoneId ?? 'ZF1').toUpperCase() } as ScenarioEventDraft;
    case 'MANUAL_EVAC_START':
    case 'MANUAL_EVAC_STOP':
      return { ...base, type, reason: '' } as ScenarioEventDraft;
    case 'PROCESS_ACK':
      return { ...base, type, ackedBy: 'trainer' } as ScenarioEventDraft;
    case 'PROCESS_CLEAR':
    case 'SYSTEM_RESET':
    default:
      return { ...base, type } as ScenarioEventDraft;
  }
}

function adaptEventForType(
  event: ScenarioEventDraft,
  type: ScenarioEvent['type'],
  defaultZoneId?: string,
): ScenarioEventDraft {
  const base = {
    id: event.id,
    offset: event.offset,
    label: event.label,
  };
  switch (type) {
    case 'DM_TRIGGER':
    case 'DM_RESET':
    case 'DAI_TRIGGER':
    case 'DAI_RESET': {
      const zone = 'zoneId' in event ? event.zoneId : undefined;
      const fallback = (defaultZoneId ?? 'ZF1').toUpperCase();
      return { ...base, type, zoneId: (zone ?? fallback).toUpperCase() } as ScenarioEventDraft;
    }
    case 'MANUAL_EVAC_START':
    case 'MANUAL_EVAC_STOP': {
      const reason = 'reason' in event ? event.reason : undefined;
      return { ...base, type, reason } as ScenarioEventDraft;
    }
    case 'PROCESS_ACK': {
      const ackedBy = 'ackedBy' in event ? event.ackedBy : undefined;
      return { ...base, type, ackedBy: ackedBy ?? 'trainer' } as ScenarioEventDraft;
    }
    case 'PROCESS_CLEAR':
    case 'SYSTEM_RESET':
    default:
      return { ...base, type } as ScenarioEventDraft;
  }
}

function normalizeEventForPayload(event: ScenarioEventDraft): ScenarioEvent {
  const offset = Number.isFinite(event.offset) ? Number(event.offset) : 0;
  const label = event.label?.toString().trim();
  switch (event.type) {
    case 'DM_TRIGGER':
    case 'DM_RESET':
    case 'DAI_TRIGGER':
    case 'DAI_RESET':
      return {
        type: event.type,
        id: event.id,
        offset,
        label: label && label.length > 0 ? label : undefined,
        zoneId: (event as { zoneId: string }).zoneId,
      };
    case 'MANUAL_EVAC_START':
    case 'MANUAL_EVAC_STOP': {
      const reason = (event as { reason?: string }).reason?.trim();
      return {
        type: event.type,
        id: event.id,
        offset,
        label: label && label.length > 0 ? label : undefined,
        reason: reason && reason.length > 0 ? reason : undefined,
      };
    }
    case 'PROCESS_ACK': {
      const ackedBy = (event as { ackedBy?: string }).ackedBy?.trim();
      return {
        type: event.type,
        id: event.id,
        offset,
        label: label && label.length > 0 ? label : undefined,
        ackedBy: ackedBy && ackedBy.length > 0 ? ackedBy : undefined,
      };
    }
    case 'PROCESS_CLEAR':
    case 'SYSTEM_RESET':
    default:
      return {
        type: event.type,
        id: event.id,
        offset,
        label: label && label.length > 0 ? label : undefined,
      } as ScenarioEvent;
  }
}

function draftToPayload(draft: ScenarioDraft): ScenarioPayload {
  const evacuationAudio = normalizeEvacuationAudio(draft.evacuationAudio);
  return {
    name: draft.name.trim(),
    description: draft.description?.trim() ? draft.description.trim() : undefined,
    topology: draft.topology ?? undefined,
    events: draft.events.map(normalizeEventForPayload),
    ...(draft.manualResetMode === 'custom'
      ? { manualResettable: normalizeManualResetSelection(draft.manualResettable) }
      : {}),
    ...(evacuationAudio ? { evacuationAudio } : {}),
  };
}

function scenarioDefinitionToDraft(definition: ScenarioDefinition): ScenarioDraft {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    topology: definition.topology ? cloneTopology(definition.topology) : null,
    events: definition.events.map(ensureDraftEvent),
    manualResetMode: definition.manualResettable ? 'custom' : 'all',
    manualResettable: normalizeManualResetSelection(definition.manualResettable),
    evacuationAudio: normalizeEvacuationAudio(definition.evacuationAudio) ?? undefined,
  };
}

const SCENARIO_EVENT_OPTIONS: Array<{ value: ScenarioEvent['type']; label: string }> = [
  { value: 'DM_TRIGGER', label: 'Déclencher DM' },
  { value: 'DM_RESET', label: 'Réinitialiser DM' },
  { value: 'DAI_TRIGGER', label: 'Détection DAI' },
  { value: 'DAI_RESET', label: 'Réinitialiser DAI' },
  { value: 'MANUAL_EVAC_START', label: 'Démarrer évacuation manuelle' },
  { value: 'MANUAL_EVAC_STOP', label: 'Arrêter évacuation manuelle' },
  { value: 'PROCESS_ACK', label: 'Acquitter le process' },
  { value: 'PROCESS_CLEAR', label: "Effacer l'acquit" },
  { value: 'SYSTEM_RESET', label: 'Reset système' },
];

const SCENARIO_ZONE_DATALIST_ID = 'scenario-zone-options';
const SCENARIO_EXPORT_FORMAT = 'simu-ssi/scenario@1';
const USER_EXPORT_FORMAT = 'simu-ssi/users@1';

function formatScenarioFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? `${slug}.scenario.json` : 'scenario.scenario.json';
}

function extractScenarioPayload(data: unknown): ScenarioPayload | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const root = data as Record<string, unknown>;
  const candidate = 'scenario' in root ? root.scenario : data;
  const payloadResult = scenarioPayloadSchema.safeParse(candidate);
  if (payloadResult.success) {
    return payloadResult.data;
  }
  const definitionResult = scenarioDefinitionSchema.safeParse(candidate);
  if (definitionResult.success) {
    const { id: _ignored, ...rest } = definitionResult.data;
    return {
      name: rest.name,
      description: rest.description,
      events: rest.events,
      topology: rest.topology,
      ...(rest.manualResettable ? { manualResettable: rest.manualResettable } : {}),
      ...(rest.evacuationAudio ? { evacuationAudio: rest.evacuationAudio } : {}),
    };
  }
  return null;
}

function formatUserExportFileName(count: number): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const suffix = count > 0 ? `-${String(count).padStart(2, '0')}` : '';
  return `ssi-utilisateurs-${year}${month}${day}${suffix}.json`;
}

function extractUserImportPayload(data: unknown): UserImportPayload | null {
  if (!data) {
    return null;
  }
  if (Array.isArray(data)) {
    return extractUserArray(data);
  }
  if (typeof data !== 'object') {
    return null;
  }
  const root = data as Record<string, unknown>;
  const format = typeof root.format === 'string' ? root.format : undefined;
  if (format && format !== USER_EXPORT_FORMAT) {
    return null;
  }
  if (Array.isArray(root.users)) {
    return extractUserArray(root.users);
  }
  return null;
}

function extractUserArray(entries: unknown[]): UserImportPayload | null {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const users: UserImportPayload['users'] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const record = entry as Record<string, unknown>;
    const rawFullName = typeof record.fullName === 'string' ? record.fullName.trim() : '';
    if (!rawFullName) {
      return null;
    }
    const rawRole = typeof record.role === 'string' ? record.role.toUpperCase() : '';
    if (rawRole !== 'TRAINER' && rawRole !== 'TRAINEE') {
      return null;
    }
    const rawId = typeof record.id === 'string' ? record.id.trim() : undefined;
    let email: string | null = null;
    if ('email' in record) {
      const value = record.email;
      if (value == null || value === '') {
        email = null;
      } else if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized && !emailRegex.test(normalized)) {
          return null;
        }
        email = normalized || null;
      } else {
        return null;
      }
    }
    users.push({
      id: rawId && rawId.length > 0 ? rawId : undefined,
      fullName: rawFullName,
      email,
      role: rawRole as UserRole,
    });
  }
  if (users.length === 0) {
    return null;
  }
  return { users };
}

function describeUserImportError(reason: string, fullName: string, email?: string | null): string {
  const identity = fullName ? `« ${fullName} »` : 'un enregistrement';
  switch (reason) {
    case 'EMAIL_ALREADY_IN_USE':
      return `l'adresse ${email ?? 'fournie'} est déjà associée à un autre compte`;
    case 'INVALID_FULL_NAME':
      return `le nom complet est manquant pour ${identity}`;
    case 'DUPLICATE_ID_IN_IMPORT':
      return `l'identifiant est dupliqué pour ${identity}`;
    case 'DUPLICATE_EMAIL_IN_IMPORT':
      return `l'adresse ${email ?? 'fournie'} apparaît plusieurs fois dans le fichier`;
    default:
      return `${identity} n'a pas pu être importé`;
  }
}

export function App() {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [snapshot, setSnapshot] = useState<DomainSnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [events, setEvents] = useState<string[]>([]);
  const [activeSection, setActiveSection] = useState<SectionId>(NAVIGATION_SECTIONS[0].id);
  const [ackPending, setAckPending] = useState(false);
  const [clearPending, setClearPending] = useState(false);
  const [simulateDmPending, setSimulateDmPending] = useState(false);
  const [simulateDaiPending, setSimulateDaiPending] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [resettingZone, setResettingZone] = useState<string | null>(null);
  const [resettingDaiZone, setResettingDaiZone] = useState<string | null>(null);
  const [accessCodes, setAccessCodes] = useState<AccessCode[]>([]);
  const [accessCodesLoading, setAccessCodesLoading] = useState(true);
  const [accessCodesError, setAccessCodesError] = useState<string | null>(null);
  const [accessCodesFeedback, setAccessCodesFeedback] = useState<string | null>(null);
  const [codeInputs, setCodeInputs] = useState<Record<number, string>>({});
  const [updatingCodeLevel, setUpdatingCodeLevel] = useState<number | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioDefinition[]>([]);
  const [scenarioStatus, setScenarioStatus] = useState<ScenarioRunnerSnapshot>({ status: 'idle' });
  const [draftScenario, setDraftScenario] = useState<ScenarioDraft>(() => createEmptyScenarioDraft());
  const [editingScenarioId, setEditingScenarioId] = useState<string | null>(null);
  const [scenarioSaving, setScenarioSaving] = useState(false);
  const [scenarioDeleting, setScenarioDeleting] = useState<string | null>(null);
  const [scenarioLoadingId, setScenarioLoadingId] = useState<string | null>(null);
  const [scenarioPreloadingId, setScenarioPreloadingId] = useState<string | null>(null);
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const [scenarioFeedback, setScenarioFeedback] = useState<string | null>(null);
  const [topology, setTopology] = useState<SiteTopology | null>(null);
  const [topologyLoading, setTopologyLoading] = useState(true);
  const [topologyError, setTopologyError] = useState<string | null>(null);
  const [topologyFeedback, setTopologyFeedback] = useState<string | null>(null);
  const [layoutDraft, setLayoutDraft] = useState<TraineeLayoutConfig>(() => cloneLayout(DEFAULT_TRAINEE_LAYOUT));
  const [layoutConfig, setLayoutConfig] = useState<TraineeLayoutConfig | null>(null);
  const [layoutLoading, setLayoutLoading] = useState(true);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [layoutFeedback, setLayoutFeedback] = useState<string | null>(null);
  const [layoutSaving, setLayoutSaving] = useState(false);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [userForm, setUserForm] = useState<{ fullName: string; email: string; role: UserRole }>(
    () => ({ fullName: '', email: '', role: 'TRAINEE' }),
  );
  const [userFormFeedback, setUserFormFeedback] = useState<string | null>(null);
  const [userActionError, setUserActionError] = useState<string | null>(null);
  const [creatingUser, setCreatingUser] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingUserDraft, setEditingUserDraft] = useState<{ fullName: string; email: string; role: UserRole } | null>(null);
  const [userDeletingId, setUserDeletingId] = useState<string | null>(null);
  const [userSavingId, setUserSavingId] = useState<string | null>(null);
  const [userImporting, setUserImporting] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(null);
  const [sessionForm, setSessionForm] = useState({
    name: '',
    mode: 'libre',
    traineeId: '',
    trainerId: '',
    objective: '',
    notes: '',
  });
  const [sessionFeedback, setSessionFeedback] = useState<string | null>(null);
  const [sessionErrorMessage, setSessionErrorMessage] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [closingSession, setClosingSession] = useState(false);
  const [generatingImprovements, setGeneratingImprovements] = useState(false);
  const [closingNotes, setClosingNotes] = useState('');
  const [improvementDrafts, setImprovementDrafts] = useState<Array<{ id: string; title: string; description: string }>>([]);
  const [activeTrainer, setActiveTrainer] = useState<UserSummary | null>(null);
  const [selectedTrainerId, setSelectedTrainerId] = useState<string>('');
  const [trainerAuthError, setTrainerAuthError] = useState<string | null>(null);
  const [trainerAuthPending, setTrainerAuthPending] = useState<boolean>(false);

  const baseUrl = useMemo(() => import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4500', []);
  const sdk = useMemo(() => new SsiSdk(baseUrl), [baseUrl]);
  const traineeOptions = useMemo(() => users.filter((user) => user.role === 'TRAINEE'), [users]);
  const trainerOptions = useMemo(() => users.filter((user) => user.role === 'TRAINER'), [users]);
  const recentSessions = useMemo(() => sessions.slice(0, 6), [sessions]);
  const scenarioFileInputRef = useRef<HTMLInputElement | null>(null);
  const scenarioAutomaticAudioInputRef = useRef<HTMLInputElement | null>(null);
  const scenarioManualAudioInputRef = useRef<HTMLInputElement | null>(null);
  const userImportInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (trainerOptions.length === 0) {
      return;
    }
    let storedId: string | null = null;
    try {
      storedId = window.localStorage.getItem('ssi-trainer-user-id');
    } catch (error) {
      console.error(error);
    }
    if (storedId && trainerOptions.some((user) => user.id === storedId)) {
      setSelectedTrainerId(storedId);
      if (!activeTrainer || activeTrainer.id !== storedId) {
        const found = trainerOptions.find((user) => user.id === storedId) ?? null;
        setActiveTrainer(found);
      }
      return;
    }
    if (!selectedTrainerId) {
      setSelectedTrainerId(trainerOptions[0]?.id ?? '');
    }
  }, [activeTrainer, selectedTrainerId, trainerOptions]);

  useEffect(() => {
    if (!activeTrainer) {
      return;
    }
    setSessionForm((prev) => (prev.trainerId === activeTrainer.id ? prev : { ...prev, trainerId: activeTrainer.id }));
  }, [activeTrainer]);

  useEffect(() => {
    if (!activeTrainer || !activeSession || activeSession.status !== 'active') {
      return;
    }
    if (activeSession.trainer?.id === activeTrainer.id) {
      return;
    }
    sdk
      .updateSession(activeSession.id, { trainerId: activeTrainer.id })
      .catch((error) => {
        console.error(error);
        setTrainerAuthError("Impossible d'associer le formateur à la session en cours.");
      });
  }, [activeTrainer, activeSession?.id, activeSession?.status, activeSession?.trainer?.id, sdk]);

  const applyActiveSession = useCallback((session: SessionSummary | null) => {
    setActiveSession(session);
    setGeneratingImprovements(false);
    if (session) {
      setClosingNotes(session.notes ?? '');
      setImprovementDrafts(
        session.improvementAreas.map((area) => ({
          id: crypto.randomUUID(),
          title: area.title,
          description: area.description ?? '',
        })),
      );
    } else {
      setClosingNotes('');
      setImprovementDrafts([]);
    }
  }, [setGeneratingImprovements]);

  const refreshScenarios = useCallback(() => {
    sdk.listScenarios().then(setScenarios).catch(console.error);
  }, [sdk]);

  const refreshScenarioStatus = useCallback(() => {
    sdk.getActiveScenario().then(setScenarioStatus).catch(console.error);
  }, [sdk]);

  const refreshUsers = useCallback(() => {
    setUsersLoading(true);
    sdk
      .listUsers()
      .then((list) => {
        setUsers(list);
        setUsersError(null);
      })
      .catch((error) => {
        console.error(error);
        setUsersError('Impossible de charger les apprenants et formateurs.');
      })
      .finally(() => setUsersLoading(false));
  }, [sdk]);

  const handleTrainerSelectChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setSelectedTrainerId(event.target.value);
    setTrainerAuthError(null);
  }, []);

  const handleTrainerLogin = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!selectedTrainerId) {
        setTrainerAuthError('Sélectionnez un compte formateur.');
        return;
      }
      const trainer = trainerOptions.find((user) => user.id === selectedTrainerId);
      if (!trainer) {
        setTrainerAuthError('Compte formateur introuvable.');
        return;
      }
      setTrainerAuthPending(true);
      setTrainerAuthError(null);
      try {
        setActiveTrainer(trainer);
        try {
          window.localStorage.setItem('ssi-trainer-user-id', trainer.id);
        } catch (storageError) {
          console.error(storageError);
        }
        if (activeSession && activeSession.status === 'active' && activeSession.trainer?.id !== trainer.id) {
          await sdk.updateSession(activeSession.id, { trainerId: trainer.id });
        }
      } catch (error) {
        console.error(error);
        setTrainerAuthError("Impossible de valider l'identification formateur.");
      } finally {
        setTrainerAuthPending(false);
      }
    },
    [activeSession?.id, activeSession?.status, activeSession?.trainer?.id, sdk, selectedTrainerId, trainerOptions],
  );

  const handleTrainerLogout = useCallback(() => {
    setActiveTrainer(null);
    try {
      window.localStorage.removeItem('ssi-trainer-user-id');
    } catch (error) {
      console.error(error);
    }
    if (activeSession && activeSession.status === 'active' && activeSession.trainer) {
      sdk
        .updateSession(activeSession.id, { trainerId: null })
        .catch((error) => {
          console.error(error);
          setTrainerAuthError("Impossible de dissocier le formateur de la session en cours.");
        });
    }
  }, [activeSession?.id, activeSession?.status, activeSession?.trainer?.id, sdk]);

  const refreshSessionsRegistry = useCallback(() => {
    setSessionsLoading(true);
    sdk
      .listSessions(20)
      .then((list) => {
        setSessions(list);
        setSessionsError(null);
      })
      .catch((error) => {
        console.error(error);
        setSessionsError('Impossible de charger les sessions.');
      })
      .finally(() => setSessionsLoading(false));
  }, [sdk]);

  const refreshActiveSession = useCallback(() => {
    sdk
      .getCurrentSession()
      .then((session) => {
        setSessionErrorMessage(null);
        applyActiveSession(session);
      })
      .catch((error) => {
        console.error(error);
        setSessionErrorMessage('Impossible de récupérer la session en cours.');
      });
  }, [applyActiveSession, sdk]);

  useEffect(() => {
    sdk.getSiteConfig().then(setConfig).catch(console.error);
    setAccessCodesLoading(true);
    sdk
      .getAccessCodes()
      .then((codes) => {
        setAccessCodes(codes);
        setCodeInputs(
          codes.reduce<Record<number, string>>((acc, entry) => {
            acc[entry.level] = entry.code;
            return acc;
          }, {}),
        );
        setAccessCodesError(null);
      })
      .catch((error) => {
        console.error(error);
        setAccessCodesError('Impossible de charger les codes d\'accès.');
      })
      .finally(() => setAccessCodesLoading(false));
    refreshScenarios();
    refreshScenarioStatus();
    refreshUsers();
    refreshSessionsRegistry();
    refreshActiveSession();
    setLayoutLoading(true);
    setLayoutFeedback(null);
    sdk
      .getTraineeLayout()
      .then((layout) => {
        setLayoutConfig(layout);
        setLayoutDraft(cloneLayout(layout));
        setLayoutError(null);
      })
      .catch((error) => {
        console.error(error);
        setLayoutError('Impossible de charger la disposition du poste apprenant.');
      })
      .finally(() => {
        setLayoutLoading(false);
      });
    const socket = io(baseUrl);
    socket.on('state.update', (state: DomainSnapshot) => setSnapshot(state));
    socket.on('events.append', (event: { ts: number; message: string; source: string }) => {
      setEvents((prev) => [`[${new Date(event.ts).toLocaleTimeString()}] ${event.source}: ${event.message}`, ...prev].slice(0, 12));
    });
    socket.on('scenario.update', (status: ScenarioRunnerSnapshot) => setScenarioStatus(status));
    socket.on('layout.update', (payload) => {
      const parsed = traineeLayoutSchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }
      setLayoutConfig(parsed.data);
      setLayoutDraft(cloneLayout(parsed.data));
      setLayoutError(null);
      setLayoutFeedback('Disposition synchronisée avec un autre poste.');
    });
    socket.on('topology.update', (payload) => {
      const parsed = siteTopologySchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }
      setTopology(parsed.data);
      setTopologyError(null);
      setTopologyLoading(false);
      setTopologyFeedback('Topologie mise à jour depuis le Studio.');
    });
    socket.on('session.update', (payload) => {
      if (payload === null) {
        applyActiveSession(null);
        refreshSessionsRegistry();
        return;
      }
      const parsed = sessionSchema.safeParse(payload);
      if (!parsed.success) {
        console.warn('Session payload invalide', parsed.error);
        return;
      }
      applyActiveSession(parsed.data);
      refreshSessionsRegistry();
    });
    return () => {
      socket.disconnect();
    };
  }, [
    applyActiveSession,
    baseUrl,
    refreshActiveSession,
    refreshScenarioStatus,
    refreshScenarios,
    refreshSessionsRegistry,
    refreshUsers,
    sdk,
  ]);

  useEffect(() => {
    let active = true;
    setTopologyLoading(true);
    sdk
      .getTopology()
      .then((data) => {
        if (!active) {
          return;
        }
        setTopology(data);
        setTopologyError(null);
        setTopologyFeedback(null);
      })
      .catch((error) => {
        console.error(error);
        if (!active) {
          return;
        }
        setTopologyError("Impossible de récupérer la cartographie du site.");
      })
      .finally(() => {
        if (active) {
          setTopologyLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [sdk]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      return;
    }
    const sectionIds = NAVIGATION_SECTIONS.map((section) => section.id) as SectionId[];
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) =>
              sectionIds.indexOf(a.target.id as SectionId) - sectionIds.indexOf(b.target.id as SectionId),
          );
        if (visible.length > 0) {
          const next = visible[0].target.id as SectionId;
          setActiveSection((current) => (current === next ? current : next));
        }
      },
      { rootMargin: '-40% 0px -55% 0px' },
    );
    sectionIds.forEach((id) => {
      const element = document.getElementById(id);
      if (element) {
        observer.observe(element);
      }
    });
    return () => observer.disconnect();
  }, []);

  const handleConfigSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const delay = Number(data.get('delay'));
    const processAckRequired = data.get('processAckRequired') === 'on';
    const evacOnDai = data.get('evacOnDAI') === 'on';
    const updated = await sdk.updateSiteConfig({
      evacOnDAI: evacOnDai,
      evacOnDMDelayMs: delay,
      processAckRequired,
    });
    setConfig(updated);
  };

  const handleUserFieldChange = useCallback(
    (field: 'fullName' | 'email' | 'role', value: string) => {
      setUserForm((prev) => ({
        ...prev,
        [field]: field === 'role' ? (value as UserRole) : value,
      }));
    },
    [],
  );

  const handleUserCreate = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmedName = userForm.fullName.trim();
      if (!trimmedName) {
        setUserActionError('Le nom est requis pour créer un utilisateur.');
        return;
      }
      setCreatingUser(true);
      setUserActionError(null);
      try {
        await sdk.createUser({
          fullName: trimmedName,
          email: userForm.email.trim() ? userForm.email.trim() : undefined,
          role: userForm.role,
        });
        setUserForm({ fullName: '', email: '', role: 'TRAINEE' });
        setUserFormFeedback('Utilisateur créé avec succès.');
        refreshUsers();
      } catch (error) {
        console.error(error);
        setUserActionError("Impossible d'ajouter l'utilisateur. Veuillez vérifier les informations saisies.");
      } finally {
        setCreatingUser(false);
      }
    },
    [refreshUsers, sdk, userForm.email, userForm.fullName, userForm.role],
  );

  const handleUserEditInit = useCallback((user: UserSummary) => {
    setEditingUserId(user.id);
    setEditingUserDraft({ fullName: user.fullName, email: user.email ?? '', role: user.role });
    setUserActionError(null);
    setUserFormFeedback(null);
  }, []);

  const handleUserEditFieldChange = useCallback(
    (field: 'fullName' | 'email' | 'role', value: string) => {
      setEditingUserDraft((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          [field]: field === 'role' ? (value as UserRole) : value,
        };
      });
    },
    [],
  );

  const handleUserEditCancel = useCallback(() => {
    setEditingUserId(null);
    setEditingUserDraft(null);
    setUserSavingId(null);
    setUserActionError(null);
  }, []);

  const handleUserEditSubmit = useCallback(async () => {
    if (!editingUserId || !editingUserDraft) {
      return;
    }
    const trimmedName = editingUserDraft.fullName.trim();
    if (!trimmedName) {
      setUserActionError('Le nom ne peut pas être vide.');
      return;
    }
    setUserSavingId(editingUserId);
    setUserActionError(null);
    try {
      await sdk.updateUser(editingUserId, {
        fullName: trimmedName,
        email: editingUserDraft.email.trim() ? editingUserDraft.email.trim() : null,
        role: editingUserDraft.role,
      });
      setUserFormFeedback('Utilisateur mis à jour.');
      setEditingUserId(null);
      setEditingUserDraft(null);
      refreshUsers();
    } catch (error) {
      console.error(error);
      setUserActionError("Impossible de mettre à jour l'utilisateur. Vérifiez les dépendances ou l'adresse e-mail.");
    } finally {
      setUserSavingId(null);
    }
  }, [editingUserDraft, editingUserId, refreshUsers, sdk]);

  const handleUserDelete = useCallback(
    async (id: string) => {
      setUserDeletingId(id);
      setUserActionError(null);
      try {
        await sdk.deleteUser(id);
        refreshUsers();
      } catch (error) {
        console.error(error);
        setUserActionError("Suppression impossible : l'utilisateur est peut-être lié à des sessions existantes.");
      } finally {
        setUserDeletingId(null);
      }
    },
    [refreshUsers, sdk],
  );

  const handleUserExport = useCallback(() => {
    if (users.length === 0) {
      setUserActionError('Aucun utilisateur à exporter.');
      setUserFormFeedback(null);
      return;
    }
    const exportPayload = {
      format: USER_EXPORT_FORMAT,
      exportedAt: new Date().toISOString(),
      count: users.length,
      users: users.map((user) => ({
        id: user.id,
        fullName: user.fullName,
        email: user.email ?? null,
        role: user.role,
      })),
    } satisfies {
      format: string;
      exportedAt: string;
      count: number;
      users: Array<{ id: string; fullName: string; email: string | null; role: UserRole }>;
    };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = formatUserExportFileName(users.length);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setUserFormFeedback(
      `${users.length} utilisateur${users.length > 1 ? 's' : ''} exporté${users.length > 1 ? 's' : ''}.`,
    );
    setUserActionError(null);
  }, [users]);

  const handleUserImportClick = useCallback(() => {
    setUserActionError(null);
    setUserFormFeedback(null);
    userImportInputRef.current?.click();
  }, []);

  const handleUserImportFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }
      setUserImporting(true);
      setUserActionError(null);
      setUserFormFeedback(null);
      try {
        const text = await file.text();
        const parsed = extractUserImportPayload(JSON.parse(text));
        if (!parsed) {
          throw new Error('INVALID_USER_FILE');
        }
        const result: UserImportResult = await sdk.importUsers(parsed);
        refreshUsers();
        const { created, updated, skipped, errors } = result;
        const parts: string[] = [];
        if (created > 0) {
          parts.push(`${created} ${created > 1 ? 'utilisateurs créés' : 'utilisateur créé'}`);
        }
        if (updated > 0) {
          parts.push(`${updated} ${updated > 1 ? 'utilisateurs mis à jour' : 'utilisateur mis à jour'}`);
        }
        if (parts.length === 0) {
          parts.push('aucune modification appliquée');
        }
        const skippedLabel = skipped > 0 ? ` (${skipped} ignoré${skipped > 1 ? 's' : ''})` : '';
        setUserFormFeedback(`Import terminé : ${parts.join(', ')}${skippedLabel}.`);
        if (errors && errors.length > 0) {
          const [firstError, ...rest] = errors;
          const description = describeUserImportError(firstError.reason, firstError.fullName, firstError.email);
          const extra = rest.length > 0 ? ` (+${rest.length} autres)` : '';
          setUserActionError(`Import partiel : ${description}${extra}.`);
        }
      } catch (error) {
        console.error(error);
        setUserActionError("Import impossible. Vérifiez le format du fichier JSON.");
      } finally {
        setUserImporting(false);
        event.target.value = '';
      }
    },
    [refreshUsers, sdk],
  );

  const handleSessionFormChange = useCallback(
    (field: keyof typeof sessionForm, value: string) => {
      setSessionForm((prev) => ({
        ...prev,
        [field]: value,
      }));
    },
    [],
  );

  const handleSessionCreate = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmedName = sessionForm.name.trim();
      if (!trimmedName) {
        setSessionErrorMessage('Le nom de la session est requis.');
        return;
      }
      setCreatingSession(true);
      setSessionErrorMessage(null);
      try {
        await sdk.createSession({
          name: trimmedName,
          mode: sessionForm.mode.trim() || undefined,
          traineeId: sessionForm.traineeId || undefined,
          trainerId: sessionForm.trainerId || undefined,
          objective: sessionForm.objective.trim() || undefined,
          notes: sessionForm.notes.trim() || undefined,
        });
        setSessionFeedback('Session démarrée.');
        setSessionForm({ name: '', mode: 'libre', traineeId: '', trainerId: '', objective: '', notes: '' });
        refreshActiveSession();
        refreshSessionsRegistry();
      } catch (error) {
        console.error(error);
        setSessionErrorMessage('Impossible de créer la session. Vérifiez qu\'aucune autre session n\'est active.');
      } finally {
        setCreatingSession(false);
      }
    },
    [refreshActiveSession, refreshSessionsRegistry, sdk, sessionForm.mode, sessionForm.name, sessionForm.notes, sessionForm.objective, sessionForm.traineeId, sessionForm.trainerId],
  );

  const handleAddImprovement = useCallback(() => {
    setSessionErrorMessage(null);
    setImprovementDrafts((prev) => {
      if (prev.length >= 5) {
        setSessionErrorMessage('Limite de 5 axes atteinte.');
        return prev;
      }
      return [...prev, { id: crypto.randomUUID(), title: '', description: '' }];
    });
  }, []);

  const handleGenerateImprovements = useCallback(async () => {
    if (!activeSession) {
      return;
    }
    setSessionErrorMessage(null);
    setSessionFeedback(null);
    setGeneratingImprovements(true);
    try {
      const suggestions = await sdk.generateImprovementSuggestions(activeSession.id);
      setImprovementDrafts(
        suggestions.map((suggestion) => ({
          id: crypto.randomUUID(),
          title: suggestion.title,
          description: suggestion.description ?? '',
        })),
      );
      setSessionFeedback(
        suggestions.length > 0
          ? 'Axes générés automatiquement.'
          : "Aucun axe automatique proposé pour ce scénario.",
      );
    } catch (error) {
      console.error(error);
      setSessionErrorMessage('Impossible de générer des axes automatiquement.');
    } finally {
      setGeneratingImprovements(false);
    }
  }, [activeSession, sdk, setGeneratingImprovements, setImprovementDrafts, setSessionErrorMessage, setSessionFeedback]);

  const handleImprovementChange = useCallback(
    (id: string, field: 'title' | 'description', value: string) => {
      setImprovementDrafts((prev) =>
        prev.map((item) => (item.id === id ? { ...item, [field]: value } : item)),
      );
    },
    [],
  );

  const handleImprovementRemove = useCallback((id: string) => {
    setImprovementDrafts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const handleCloseSession = useCallback(async () => {
    if (!activeSession) {
      return;
    }
    setClosingSession(true);
    setSessionErrorMessage(null);
    const improvements: SessionImprovement[] = improvementDrafts
      .map((item) => ({
        title: item.title.trim(),
        description: item.description.trim(),
      }))
      .filter((item) => item.title.length > 0)
      .map((item) => ({
        title: item.title,
        description: item.description.length > 0 ? item.description : undefined,
      }));
    try {
      await sdk.closeSession(activeSession.id, {
        notes: closingNotes.trim() ? closingNotes.trim() : null,
        improvementAreas: improvements,
      });
      setSessionFeedback('Session clôturée.');
      refreshActiveSession();
      refreshSessionsRegistry();
    } catch (error) {
      console.error(error);
      setSessionErrorMessage('Impossible de clôturer la session.');
    } finally {
      setClosingSession(false);
    }
  }, [activeSession, closingNotes, improvementDrafts, refreshActiveSession, refreshSessionsRegistry, sdk]);

  const handleAcknowledge = useCallback(async () => {
    setAckPending(true);
    try {
      await sdk.acknowledgeProcess('trainer');
    } catch (error) {
      console.error(error);
    } finally {
      setAckPending(false);
    }
  }, [sdk]);

  const handleClearAck = useCallback(async () => {
    setClearPending(true);
    try {
      await sdk.clearProcessAck();
    } catch (error) {
      console.error(error);
    } finally {
      setClearPending(false);
    }
  }, [sdk]);

  const handleSimulateDm = useCallback(async () => {
    setSimulateDmPending(true);
    try {
      await sdk.activateManualCallPoint('ZF1');
    } catch (error) {
      console.error(error);
    } finally {
      setSimulateDmPending(false);
    }
  }, [sdk]);

  const handleSimulateDai = useCallback(async () => {
    setSimulateDaiPending(true);
    try {
      await sdk.activateAutomaticDetector('ZF1');
    } catch (error) {
      console.error(error);
    } finally {
      setSimulateDaiPending(false);
    }
  }, [sdk]);

  const handleResetSystem = useCallback(async () => {
    setResetPending(true);
    try {
      await sdk.resetSystem();
      await sdk.clearProcessAck();
    } catch (error) {
      console.error(error);
    } finally {
      setResetPending(false);
    }
  }, [sdk]);

  const handleResetDm = useCallback(
    async (zoneId: string) => {
      setResettingZone(zoneId);
      try {
        await sdk.resetManualCallPoint(zoneId);
      } catch (error) {
        console.error(error);
      } finally {
        setResettingZone((current) => (current === zoneId ? null : current));
      }
    },
    [sdk],
  );

  const handleResetDai = useCallback(
    async (zoneId: string) => {
      setResettingDaiZone(zoneId);
      try {
        await sdk.resetAutomaticDetector(zoneId);
      } catch (error) {
        console.error(error);
      } finally {
        setResettingDaiZone((current) => (current === zoneId ? null : current));
      }
    },
    [sdk],
  );

  const handleLayoutMove = useCallback(
    (section: 'board' | 'controls' | 'panels', id: string, direction: -1 | 1) => {
      setLayoutFeedback(null);
      setLayoutError(null);
      setLayoutDraft((prev) => {
        const board = [...prev.boardModuleOrder];
        const controls = [...prev.controlButtonOrder];
        const panels = [...prev.sidePanelOrder];
        const boardHidden = sortByBaseline(prev.boardModuleHidden ?? [], BOARD_BASELINE);
        const controlHidden = sortByBaseline(prev.controlButtonHidden ?? [], CONTROL_BASELINE);
        const panelHidden = sortByBaseline(prev.sidePanelHidden ?? [], PANEL_BASELINE);
        const target = section === 'board' ? board : section === 'controls' ? controls : panels;
        const index = target.indexOf(id);
        const newIndex = index + direction;
        if (index === -1 || newIndex < 0 || newIndex >= target.length) {
          return prev;
        }
        target.splice(index, 1);
        target.splice(newIndex, 0, id);
        return {
          boardModuleOrder: board,
          boardModuleHidden: boardHidden,
          controlButtonOrder: controls,
          controlButtonHidden: controlHidden,
          sidePanelOrder: panels,
          sidePanelHidden: panelHidden,
        };
      });
    },
    [],
  );

  const handleLayoutToggleVisibility = useCallback((section: 'board' | 'controls' | 'panels', id: string) => {
    setLayoutFeedback(null);
    setLayoutError(null);
    setLayoutDraft((prev) => {
      const boardHidden = new Set(prev.boardModuleHidden ?? []);
      const controlHidden = new Set(prev.controlButtonHidden ?? []);
      const panelHidden = new Set(prev.sidePanelHidden ?? []);
      const target = section === 'board' ? boardHidden : section === 'controls' ? controlHidden : panelHidden;
      if (target.has(id)) {
        target.delete(id);
      } else {
        target.add(id);
      }
      return {
        boardModuleOrder: [...prev.boardModuleOrder],
        boardModuleHidden: sortByBaseline(Array.from(boardHidden), BOARD_BASELINE),
        controlButtonOrder: [...prev.controlButtonOrder],
        controlButtonHidden: sortByBaseline(Array.from(controlHidden), CONTROL_BASELINE),
        sidePanelOrder: [...prev.sidePanelOrder],
        sidePanelHidden: sortByBaseline(Array.from(panelHidden), PANEL_BASELINE),
      };
    });
  }, []);

  const handleLayoutRestoreSaved = useCallback(() => {
    setLayoutFeedback(null);
    setLayoutError(null);
    if (layoutConfig) {
      setLayoutDraft(cloneLayout(layoutConfig));
    }
  }, [layoutConfig]);

  const handleLayoutResetToDefault = useCallback(() => {
    setLayoutFeedback(null);
    setLayoutError(null);
    setLayoutDraft(cloneLayout(DEFAULT_TRAINEE_LAYOUT));
  }, []);

  const handleLayoutSave = useCallback(async () => {
    setLayoutSaving(true);
    setLayoutFeedback(null);
    setLayoutError(null);
    try {
      const updated = await sdk.updateTraineeLayout(layoutDraft);
      setLayoutConfig(updated);
      setLayoutDraft(cloneLayout(updated));
      setLayoutFeedback('Disposition du poste apprenant enregistrée.');
    } catch (error) {
      console.error(error);
      setLayoutError("Impossible d'enregistrer la disposition du poste apprenant.");
    } finally {
      setLayoutSaving(false);
    }
  }, [layoutDraft, sdk]);

  const handleAccessCodeInputChange = useCallback((level: number, value: string) => {
    setCodeInputs((prev) => ({ ...prev, [level]: value }));
  }, []);

  const handleAccessCodeSubmit = useCallback(
    async (level: number) => {
      const value = (codeInputs[level] ?? '').trim();
      if (value.length < 4 || value.length > 8) {
        setAccessCodesError('Le code doit comporter entre 4 et 8 chiffres.');
        setAccessCodesFeedback(null);
        return;
      }
      if (!/^[0-9]+$/.test(value)) {
        setAccessCodesError('Utilisez uniquement des chiffres pour le code.');
        setAccessCodesFeedback(null);
        return;
      }
      setAccessCodesError(null);
      setAccessCodesFeedback(null);
      setUpdatingCodeLevel(level);
      try {
        const updated = await sdk.updateAccessCode(level, value);
        setAccessCodes((prev) => {
          const others = prev.filter((entry) => entry.level !== level);
          return [...others, updated].sort((a, b) => a.level - b.level);
        });
        setCodeInputs((prev) => ({ ...prev, [level]: updated.code }));
        setAccessCodesFeedback(`Code niveau ${level} mis à jour.`);
      } catch (error) {
        console.error(error);
        const message = error instanceof Error ? error.message : 'Erreur inattendue';
        if (message === 'CODE_ALREADY_IN_USE') {
          setAccessCodesError('Ce code est déjà attribué à un autre niveau.');
        } else if (message === 'CODE_DIGITS_ONLY') {
          setAccessCodesError('Le code ne doit contenir que des chiffres.');
        } else if (message === 'INVALID_LEVEL') {
          setAccessCodesError('Niveau non pris en charge.');
        } else {
          setAccessCodesError('Impossible de mettre à jour le code.');
        }
        setAccessCodesFeedback(null);
      } finally {
        setUpdatingCodeLevel(null);
      }
    },
    [codeInputs, sdk],
  );

  const updateDraftEvent = (eventId: string, updater: (event: ScenarioEventDraft) => ScenarioEventDraft) => {
    setDraftScenario((prev) => ({
      ...prev,
      events: prev.events.map((event) => (event.id === eventId ? updater(event) : event)),
    }));
  };

  const handleScenarioAddEvent = () => {
    setDraftScenario((prev) => ({
      ...prev,
      events: [...prev.events, createDraftEvent('DM_TRIGGER', defaultScenarioZoneId)],
    }));
  };

  const handleScenarioRemoveEvent = (eventId: string) => {
    setDraftScenario((prev) => ({
      ...prev,
      events: prev.events.filter((event) => event.id !== eventId),
    }));
  };

  const handleScenarioEventTypeChange = (eventId: string, type: ScenarioEvent['type']) => {
    updateDraftEvent(eventId, (event) =>
      adaptEventForType({ ...event, type } as ScenarioEventDraft, type, defaultScenarioZoneId),
    );
  };

  const handleScenarioEventOffsetChange = (eventId: string, value: number) => {
    updateDraftEvent(eventId, (event) => ({ ...event, offset: value }) as ScenarioEventDraft);
  };

  const handleScenarioEventZoneChange = (eventId: string, zoneId: string) => {
    updateDraftEvent(eventId, (event) => ({ ...event, zoneId: zoneId.toUpperCase() }) as ScenarioEventDraft);
  };

  const handleScenarioEventReasonChange = (eventId: string, reason: string) => {
    updateDraftEvent(eventId, (event) => ({ ...event, reason }) as ScenarioEventDraft);
  };

  const handleScenarioEventAckedByChange = (eventId: string, ackedBy: string) => {
    updateDraftEvent(eventId, (event) => ({ ...event, ackedBy }) as ScenarioEventDraft);
  };

  const handleScenarioEventLabelChange = (eventId: string, label: string) => {
    updateDraftEvent(eventId, (event) => ({ ...event, label }) as ScenarioEventDraft);
  };

  const handleScenarioManualResetModeChange = (mode: 'all' | 'custom') => {
    setDraftScenario((prev) => ({
      ...prev,
      manualResetMode: mode,
      manualResettable: normalizeManualResetSelection(prev.manualResettable),
    }));
  };

  const handleScenarioManualResetToggle = (kind: 'DM' | 'DAI', zoneId: string) => {
    setDraftScenario((prev) => {
      const normalized = zoneId.toUpperCase();
      const selection = normalizeManualResetSelection(prev.manualResettable);
      const currentList = kind === 'DM' ? selection.dmZones : selection.daiZones;
      const hasZone = currentList.includes(normalized);
      const nextList = hasZone
        ? currentList.filter((zone) => zone !== normalized)
        : [...currentList, normalized];
      nextList.sort((a, b) => a.localeCompare(b));
      const nextSelection =
        kind === 'DM'
          ? { ...selection, dmZones: nextList }
          : { ...selection, daiZones: nextList };
      return {
        ...prev,
        manualResetMode: prev.manualResetMode === 'custom' ? prev.manualResetMode : 'custom',
        manualResettable: nextSelection,
      };
    });
  };

  const handleScenarioEvacuationAudioSelect = useCallback(
    (kind: 'automatic' | 'manual') => {
      setScenarioError(null);
      setScenarioFeedback(null);
      if (kind === 'automatic') {
        scenarioAutomaticAudioInputRef.current?.click();
      } else {
        scenarioManualAudioInputRef.current?.click();
      }
    },
    [scenarioAutomaticAudioInputRef, scenarioManualAudioInputRef],
  );

  const handleScenarioEvacuationAudioChange = useCallback(
    async (kind: 'automatic' | 'manual', event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }
      if (file.type && !file.type.startsWith('audio/')) {
        setScenarioError('Sélectionnez un fichier audio (mp3, wav, …).');
        event.target.value = '';
        return;
      }
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result === 'string') {
              resolve(reader.result);
            } else {
              reject(new Error("Format de fichier audio invalide."));
            }
          };
          reader.onerror = () => {
            reject(reader.error ?? new Error("Lecture du fichier audio impossible."));
          };
          reader.readAsDataURL(file);
        });
        setDraftScenario((prev) => {
          const previous = prev.evacuationAudio ?? {};
          const asset: ScenarioAudioAsset = { name: file.name, dataUrl };
          const next = {
            ...previous,
            [kind]: asset,
          } as ScenarioEvacuationAudio;
          return {
            ...prev,
            evacuationAudio: next,
          };
        });
        setScenarioError(null);
        setScenarioFeedback(
          kind === 'automatic'
            ? "Son d'évacuation automatique chargé."
            : "Son d'évacuation manuelle chargé.",
        );
      } catch (error) {
        console.error(error);
        setScenarioError("Impossible de charger le fichier audio d'évacuation.");
        setScenarioFeedback(null);
      } finally {
        event.target.value = '';
      }
    },
    [setDraftScenario, setScenarioError, setScenarioFeedback],
  );

  const handleScenarioEvacuationAudioClear = useCallback(
    (kind: 'automatic' | 'manual') => {
      let removed = false;
      setDraftScenario((prev) => {
        if (!prev.evacuationAudio?.[kind]) {
          return prev;
        }
        removed = true;
        const remaining = { ...prev.evacuationAudio } as ScenarioEvacuationAudio;
        delete (remaining as Record<'automatic' | 'manual', ScenarioAudioAsset | undefined>)[kind];
        const normalized = normalizeEvacuationAudio(remaining);
        return {
          ...prev,
          evacuationAudio: normalized ?? undefined,
        };
      });
      if (removed) {
        setScenarioError(null);
        setScenarioFeedback(
          kind === 'automatic'
            ? "Son d'évacuation automatique supprimé."
            : "Son d'évacuation manuelle supprimé.",
        );
      }
    },
    [setDraftScenario, setScenarioError, setScenarioFeedback],
  );

  const handleScenarioNameChange = (name: string) => {
    setDraftScenario((prev) => ({ ...prev, name }));
  };

  const handleScenarioDescriptionChange = (description: string) => {
    setDraftScenario((prev) => ({ ...prev, description }));
  };

  const handleScenarioAttachTopology = useCallback(() => {
    if (!topology) {
      setScenarioError("Aucun plan n'est disponible. Importez une cartographie dans l'Admin Studio.");
      setScenarioFeedback(null);
      return;
    }
    setDraftScenario((prev) => ({ ...prev, topology: cloneTopology(topology) }));
    setScenarioError(null);
    setScenarioFeedback('Plan interactif associé au scénario.');
  }, [topology]);

  const handleScenarioDetachTopology = useCallback(() => {
    setDraftScenario((prev) => ({ ...prev, topology: null }));
    setScenarioFeedback('Plan interactif détaché du scénario.');
  }, []);

  const handleScenarioResetForm = () => {
    setDraftScenario(createEmptyScenarioDraft());
    setEditingScenarioId(null);
    setScenarioError(null);
    setScenarioFeedback(null);
  };

  const handleScenarioEdit = useCallback(
    async (scenario: ScenarioDefinition) => {
      setScenarioError(null);
      setScenarioFeedback(null);

      if (scenario.topology?.plan?.image) {
        setDraftScenario(scenarioDefinitionToDraft(scenario));
        setEditingScenarioId(scenario.id);
        return;
      }

      setScenarioLoadingId(scenario.id);
      try {
        const detailed = await sdk.getScenario(scenario.id);
        setDraftScenario(scenarioDefinitionToDraft(detailed));
        setEditingScenarioId(detailed.id);
        setScenarios((prev) => prev.map((entry) => (entry.id === detailed.id ? detailed : entry)));
      } catch (error) {
        console.error(error);
        setDraftScenario(scenarioDefinitionToDraft(scenario));
        setEditingScenarioId(scenario.id);
        setScenarioError('Impossible de récupérer le plan associé au scénario sélectionné.');
      } finally {
        setScenarioLoadingId((current) => (current === scenario.id ? null : current));
      }
    },
    [sdk, setScenarios],
  );

  const handleScenarioDelete = async (scenarioId: string) => {
    setScenarioDeleting(scenarioId);
    try {
      await sdk.deleteScenario(scenarioId);
      if (editingScenarioId === scenarioId) {
        handleScenarioResetForm();
      }
      refreshScenarios();
      setScenarioFeedback('Scénario supprimé.');
    } catch (error) {
      console.error(error);
      setScenarioFeedback(null);
    } finally {
      setScenarioDeleting((current) => (current === scenarioId ? null : current));
    }
  };

  const handleScenarioSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draftScenario.name.trim()) {
      setScenarioError('Le nom du scénario est obligatoire.');
      return;
    }
    if (draftScenario.events.length === 0) {
      setScenarioError('Ajoutez au moins un événement.');
      return;
    }
    setScenarioError(null);
    setScenarioFeedback(null);
    setScenarioSaving(true);
    try {
      const payload = draftToPayload(draftScenario);
      const wasEditing = Boolean(editingScenarioId);
      const saved = editingScenarioId
        ? await sdk.updateScenario(editingScenarioId, payload)
        : await sdk.createScenario(payload);
      setDraftScenario(scenarioDefinitionToDraft(saved));
      setEditingScenarioId(saved.id);
      refreshScenarios();
      setScenarioFeedback(wasEditing ? 'Scénario mis à jour.' : 'Scénario créé.');
    } catch (error) {
      console.error(error);
      setScenarioError('Impossible de sauvegarder le scénario.');
      setScenarioFeedback(null);
    } finally {
      setScenarioSaving(false);
    }
  };

  const handleScenarioExport = useCallback((scenario: ScenarioDefinition) => {
      const exportPayload = {
        format: SCENARIO_EXPORT_FORMAT,
        exportedAt: new Date().toISOString(),
        source: { id: scenario.id },
        scenario: {
          name: scenario.name,
          description: scenario.description,
          events: scenario.events,
          ...(scenario.topology ? { topology: scenario.topology } : {}),
          ...(scenario.manualResettable ? { manualResettable: scenario.manualResettable } : {}),
          ...(scenario.evacuationAudio ? { evacuationAudio: scenario.evacuationAudio } : {}),
        },
      };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = formatScenarioFileName(scenario.name);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, []);

  const handleScenarioImportClick = useCallback(() => {
    setScenarioError(null);
    setScenarioFeedback(null);
    scenarioFileInputRef.current?.click();
  }, [scenarioFileInputRef]);

  const handleScenarioFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }
      setScenarioSaving(true);
      setScenarioError(null);
      setScenarioFeedback(null);
      try {
        const text = await file.text();
        const parsed = extractScenarioPayload(JSON.parse(text));
        if (!parsed) {
          throw new Error('INVALID_SCENARIO_FILE');
        }
        const sanitized: ScenarioPayload = {
          name: parsed.name.trim(),
          description: parsed.description?.trim() ? parsed.description.trim() : undefined,
          topology: parsed.topology ? cloneTopology(parsed.topology) : undefined,
          events: parsed.events.map((event) => ({ ...event })),
        };
        if (sanitized.events.length === 0) {
          throw new Error('SCENARIO_EVENTS_MISSING');
        }
        const created = await sdk.createScenario(sanitized);
        setDraftScenario(scenarioDefinitionToDraft(created));
        setEditingScenarioId(created.id);
        refreshScenarios();
        setScenarioFeedback(`Scénario « ${created.name} » importé avec succès.`);
      } catch (error) {
        console.error(error);
        setScenarioError("Import impossible. Vérifiez le fichier sélectionné.");
        setScenarioFeedback(null);
      } finally {
        setScenarioSaving(false);
        event.target.value = '';
      }
    },
    [refreshScenarios, sdk],
  );

  const handleScenarioRun = async (scenarioId: string) => {
    try {
      const status = await sdk.runScenario(scenarioId);
      setScenarioStatus(status);
    } catch (error) {
      console.error(error);
    }
  };

  const handleScenarioPreload = async (scenarioId: string) => {
    setScenarioPreloadingId(scenarioId);
    try {
      const status = await sdk.preloadScenario(scenarioId);
      setScenarioStatus(status);
    } catch (error) {
      console.error(error);
    } finally {
      setScenarioPreloadingId((current) => (current === scenarioId ? null : current));
    }
  };

  const handleScenarioStop = async () => {
    try {
      const status = await sdk.stopScenario();
      setScenarioStatus(status);
    } catch (error) {
      console.error(error);
    }
  };

  const handleScenarioComplete = async () => {
    try {
      const status = await sdk.completeScenario();
      setScenarioStatus(status);
    } catch (error) {
      console.error(error);
    }
  };

  const remainingMs = snapshot?.cmsi?.status === 'EVAC_SUSPENDED'
    ? snapshot.cmsi.remainingMs ?? undefined
    : snapshot?.cmsi?.deadline != null
    ? Math.max(0, snapshot.cmsi.deadline - now)
    : undefined;
  const dmList = Object.values(snapshot?.dmLatched ?? {});
  const daiList = Object.values(snapshot?.daiActivated ?? {});
  const manualActive = Boolean(snapshot?.manualEvacuation);
  const scenarioTopology = useMemo(() => {
    const activeTopology = scenarioStatus.scenario?.topology ?? null;
    if (scenarioStatus.status === 'running' && activeTopology) {
      return activeTopology;
    }
    if (draftScenario.topology) {
      return draftScenario.topology;
    }
    return activeTopology ?? topology ?? null;
  }, [draftScenario.topology, scenarioStatus.scenario, scenarioStatus.status, topology]);
  const planMetadata = useMemo(() => extractPlanMetadata(scenarioTopology), [scenarioTopology]);
  const draftPlanMetadata = useMemo(() => extractPlanMetadata(draftScenario.topology), [draftScenario.topology]);
  const devicesByZone = useMemo(() => {
    const map = new Map<string, SiteDevice[]>();
    if (!topology) {
      return map;
    }
    for (const device of topology.devices) {
      const zoneKey = device.zoneId ?? UNASSIGNED_ZONE_KEY;
      const current = map.get(zoneKey) ?? [];
      current.push(device);
      map.set(zoneKey, current);
    }
    for (const [, devices] of map) {
      devices.sort((a, b) => {
        const kindComparison = a.kind.localeCompare(b.kind);
        if (kindComparison !== 0) {
          return kindComparison;
        }
        return resolveDeviceLabel(a).localeCompare(resolveDeviceLabel(b));
      });
    }
    return map;
  }, [topology]);
  const unassignedDevices = devicesByZone.get(UNASSIGNED_ZONE_KEY) ?? [];
  const hasTopologyData = Boolean(topology && (topology.zones.length > 0 || topology.devices.length > 0));
  const scenarioZoneOptions = useMemo(() => {
    const sourceTopology = scenarioTopology ?? topology;
    if (!sourceTopology) {
      return [] as Array<{ value: string; label: string; kind?: string }>;
    }
    return [...sourceTopology.zones]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((zone) => ({
        value: zone.id.toUpperCase(),
        label: `${zone.label} (${zone.id.toUpperCase()})`,
        kind: zone.kind,
      }));
  }, [scenarioTopology, topology]);
  const scenarioZoneLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of scenarioZoneOptions) {
      map.set(option.value, option.label);
    }
    return map;
  }, [scenarioZoneOptions]);
  const manualResetOptions = useMemo(() => {
    const sourceTopology = scenarioTopology ?? topology;
    if (!sourceTopology) {
      return {
        dm: [] as Array<{ value: string; label: string }>,
        dai: [] as Array<{ value: string; label: string }>,
      };
    }
    const buildOptions = (kind: 'DM' | 'DAI') => {
      const zones = new Set<string>();
      for (const device of sourceTopology.devices) {
        if (device.kind === kind && device.zoneId) {
          zones.add(device.zoneId.toUpperCase());
        }
      }
      return Array.from(zones)
        .sort((a, b) => a.localeCompare(b))
        .map((zoneId) => ({
          value: zoneId,
          label: scenarioZoneLabelMap.get(zoneId) ?? zoneId,
        }));
    };
    return { dm: buildOptions('DM'), dai: buildOptions('DAI') };
  }, [scenarioTopology, topology, scenarioZoneLabelMap]);
  const defaultScenarioZoneId = scenarioZoneOptions[0]?.value ?? 'ZF1';
  const sortedDraftEvents = useMemo(
    () => [...draftScenario.events].sort((a, b) => a.offset - b.offset),
    [draftScenario.events],
  );
  const scenarioStateLabel = translateScenarioStatus(
    scenarioStatus.status,
    scenarioStatus.awaitingSystemReset,
  );
  const nextScenarioEvent = describeScenarioEvent(scenarioStatus);
  const scenarioIsRunning = scenarioStatus.status === 'running';
  const scenarioIsReady = scenarioStatus.status === 'ready';
  const scenarioIsActive = scenarioIsRunning || scenarioIsReady;
  const audibleState = snapshot?.ugaActive
    ? { value: 'Diffusion', tone: 'critical' as const, footer: 'Alarme générale en cours' }
    : snapshot?.localAudibleActive
    ? { value: 'Signal local', tone: 'warning' as const, footer: 'Préalarme sonore active au CMSI' }
    : { value: 'Repos', tone: 'neutral' as const, footer: 'Pré-alerte en veille' };
  const accessCodeMap = useMemo(() => {
    const map = new Map<number, AccessCode>();
    accessCodes.forEach((entry) => map.set(entry.level, entry));
    return map;
  }, [accessCodes]);
  const isLayoutDirty = layoutConfig ? JSON.stringify(layoutDraft) !== JSON.stringify(layoutConfig) : false;

  return (
    <div className="console-shell">
      <aside className="primary-menu">
        <div className="primary-menu__header">
          <p className="primary-menu__eyebrow">Console formateur</p>
          <h2 className="primary-menu__title">Menu principal</h2>
          <p className="primary-menu__subtitle">
            Gérez la session de formation et accédez rapidement aux outils clés.
          </p>
        </div>
        <nav className="primary-menu__nav" aria-label="Navigation principale">
          <ul className="primary-menu__list">
            {NAVIGATION_SECTIONS.map((section) => (
              <li key={section.id} className="primary-menu__item">
                <a
                  href={`#${section.id}`}
                  className={`primary-menu__link ${activeSection === section.id ? 'is-active' : ''}`}
                  onClick={() => setActiveSection(section.id)}
                  onFocus={() => setActiveSection(section.id)}
                >
                  <span>{section.label}</span>
                  <span className="primary-menu__chevron" aria-hidden="true">
                    →
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="primary-menu__footer">
          <span className="primary-menu__hint">Dernier événement</span>
          <span className="primary-menu__last-event" title={events[0] ?? '—'}>
            {events[0] ?? '—'}
          </span>
        </div>
      </aside>

      <main className="console-content">
        <section id="overview" className="console-section console-section--hero">
          <header className="app-header">
            <div className="app-header__content">
              <p className="app-eyebrow">Poste formateur</p>
              <h1 className="app-title">Console de supervision SSI</h1>
              <p className="app-subtitle">
                Orchestration en temps réel des scénarios d'évacuation, visualisation des états critiques et pilotage des actions d'exploitation.
              </p>
              <div className="app-metrics">
                <div className="metric-card">
                  <span className="metric-card__label">DM actifs</span>
                  <span className="metric-card__value">{dmList.length}</span>
                </div>
                <div className="metric-card">
                  <span className="metric-card__label">DAI actives</span>
                  <span className="metric-card__value">{daiList.length}</span>
                </div>
                <div className="metric-card">
                  <span className="metric-card__label">Process</span>
                  <span className="metric-card__value metric-card__value--pill">
                    {snapshot?.processAck?.isAcked ? 'Acquitté' : 'En attente'}
                  </span>
                </div>
                <div className="metric-card">
                  <span className="metric-card__label">Dernier événement</span>
                  <span className="metric-card__value metric-card__value--small">
                    {events[0] ?? '—'}
                  </span>
                </div>
              </div>
            </div>
            <div className="app-header__identity">
              <div className="app-identity__status">
                <span className="app-identity__label">Formateur connecté</span>
                <span className="app-identity__value">{activeTrainer?.fullName ?? 'Aucun'}</span>
              </div>
              <form className="identity-form" onSubmit={handleTrainerLogin}>
                <label className="identity-form__field">
                  <span>Choisir un compte</span>
                  <select
                    className="identity-select"
                    value={selectedTrainerId}
                    onChange={handleTrainerSelectChange}
                    disabled={trainerOptions.length === 0}
                  >
                    {trainerOptions.length === 0 ? (
                      <option value="">Aucun formateur disponible</option>
                    ) : (
                      trainerOptions.map((trainer) => (
                        <option key={trainer.id} value={trainer.id}>
                          {trainer.fullName}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <div className="identity-actions">
                  <button
                    type="submit"
                    className="identity-button"
                    disabled={trainerAuthPending || trainerOptions.length === 0}
                  >
                    {trainerAuthPending ? 'Identification…' : "S'identifier"}
                  </button>
                  {activeTrainer && (
                    <button
                      type="button"
                      className="identity-button identity-button--secondary"
                      onClick={handleTrainerLogout}
                    >
                      Se déconnecter
                    </button>
                  )}
                </div>
              </form>
              {trainerAuthError && <p className="app-identity__error">{trainerAuthError}</p>}
            </div>
            <div className="app-shortcuts">
              <span className="app-shortcuts__label">Raccourcis</span>
              <div className="shortcut-line">
                <span className="shortcut-line__keys">
                  <kbd>Ctrl</kbd>
                  <span>+</span>
                  <kbd>M</kbd>
                </span>
                <span className="shortcut-line__description">Déclenchement</span>
              </div>
              <div className="shortcut-line">
                <span className="shortcut-line__keys">
                  <kbd>Ctrl</kbd>
                  <span>+</span>
                  <kbd>Shift</kbd>
                  <span>+</span>
                  <kbd>M</kbd>
                </span>
                <span className="shortcut-line__description">Arrêt diffusion</span>
              </div>
            </div>
          </header>
        </section>

        <section className="status-grid">
          <StatusTile
            title="CMSI"
            value={formatCmsiStatus(snapshot?.cmsi?.status)}
            tone={deriveTone(snapshot)}
            footer={snapshot?.cmsi?.manual ? 'Mode manuel engagé' : 'Mode automatique'}
          />
          <StatusTile
            title="UGA"
            value={audibleState.value}
            tone={audibleState.tone}
            footer={audibleState.footer}
          />
          <StatusTile
            title="DAS"
            value={snapshot?.dasApplied ? 'Appliqués' : 'Sécurisés'}
            tone={snapshot?.dasApplied ? 'warning' : 'success'}
            footer={snapshot?.dasApplied ? 'Isolements réalisés' : 'Conditions nominales'}
          />
          <StatusTile
            title="Process Ack"
            value={snapshot?.processAck?.isAcked ? 'Fourni' : 'Requis'}
            tone={snapshot?.processAck?.isAcked ? 'success' : 'warning'}
            footer={snapshot?.processAck?.isAcked ? 'Exploitation validée' : 'En attente opérateur'}
          />
          <StatusTile
            title="Scénario"
            value={scenarioStatus.scenario?.name ?? 'Aucun chargé'}
            tone={scenarioIsRunning ? 'warning' : scenarioStatus.status === 'completed' ? 'success' : 'neutral'}
            footer={`${scenarioStateLabel} · ${nextScenarioEvent}`}
          />
        </section>

        <section id="operations" className="console-section">
          <div className="section-header">
            <h2 className="section-header__title">Opérations en direct</h2>
            <p className="section-header__subtitle">
              Surveillez l'état du CMSI et pilotez les actions immédiates pendant l'exercice.
            </p>
          </div>
          <div className="app-main">
            <div className="app-column app-column--primary">
              <div className="card timeline-card">
                <div className="card__header">
                  <h2 className="card__title">Chronologie d'évacuation</h2>
                  <p className="card__description">
                    Surveillez les jalons clés, le reste à courir et les transitions critiques de l'exercice en cours.
                  </p>
                </div>
                <div className="timeline-badges">
                  {snapshot?.cmsi?.status === 'EVAC_PENDING' && (
                    <TimelineBadge label="Pré-alerte" state="pending" remainingMs={remainingMs} />
                  )}
                  {snapshot?.cmsi?.status === 'EVAC_ACTIVE' && (
                    <TimelineBadge label={snapshot.cmsi.manual ? 'Manuelle' : 'Automatique'} state="active" />
                  )}
                  {snapshot?.cmsi?.status === 'EVAC_SUSPENDED' && (
                    <TimelineBadge label="Suspension" state="suspended" remainingMs={remainingMs} />
                  )}
                  {snapshot?.cmsi?.status === 'SAFE_HOLD' && <TimelineBadge label="Maintien sécurisé" state="safehold" />}
                  {!snapshot && <p className="timeline-empty">Aucun scénario en cours.</p>}
                </div>
                <div className="timeline-meta">
                  <div>
                    <span className="timeline-meta__label">Délai T+5 configuré</span>
                    <span className="timeline-meta__value">{config?.evacOnDMDelayMs ?? '—'} ms</span>
                  </div>
                  <div>
                    <span className="timeline-meta__label">Dernier déclencheur</span>
                    <span className="timeline-meta__value">{snapshot?.cmsi?.zoneId ?? '—'}</span>
                  </div>
                  <div>
                    <span className="timeline-meta__label">Depuis</span>
                    <span className="timeline-meta__value">{formatTime(snapshot?.cmsi?.startedAt)}</span>
                  </div>
                </div>
              </div>

              <div className="card dm-card">
                <div className="card__header">
                  <h2 className="card__title">Déclencheurs DM verrouillés</h2>
                  <p className="card__description">Surveillez les zones à réarmer et assurez le retour à la normale.</p>
                </div>
                <ul className="dm-list">
                  {dmList.length === 0 && <li className="dm-list__empty">Aucun DM en cours.</li>}
                  {dmList.map((dm) => (
                    <li key={dm.zoneId} className="dm-item">
                      <div className="dm-item__meta">
                        <span className="dm-item__zone">Zone {dm.zoneId}</span>
                        {dm.lastActivatedAt ? (
                          <span className="dm-item__time">{formatTime(dm.lastActivatedAt)}</span>
                        ) : (
                          <span className="dm-item__time">Horodatage indisponible</span>
                        )}
                      </div>
                      <button
                        className="btn btn--outline"
                        onClick={() => handleResetDm(dm.zoneId)}
                        disabled={resettingZone === dm.zoneId}
                        aria-busy={resettingZone === dm.zoneId}
                      >
                        {resettingZone === dm.zoneId ? 'Réarmement…' : 'Réarmer'}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="card dai-card">
                <div className="card__header">
                  <h2 className="card__title">Détections automatiques</h2>
                  <p className="card__description">Visualisez les déclenchements DAI et réinitialisez les capteurs simulés.</p>
                </div>
                <ul className="dai-list">
                  {daiList.length === 0 && <li className="dai-list__empty">Aucune détection active.</li>}
                  {daiList.map((dai) => (
                    <li key={dai.zoneId} className="dai-item">
                      <div className="dai-item__meta">
                        <span className="dai-item__zone">Zone {dai.zoneId}</span>
                        {dai.lastActivatedAt ? (
                          <span className="dai-item__time">{formatTime(dai.lastActivatedAt)}</span>
                        ) : (
                          <span className="dai-item__time">Horodatage indisponible</span>
                        )}
                      </div>
                      <button
                        className="btn btn--outline"
                        onClick={() => handleResetDai(dai.zoneId)}
                        disabled={resettingDaiZone === dai.zoneId}
                        aria-busy={resettingDaiZone === dai.zoneId}
                      >
                        {resettingDaiZone === dai.zoneId ? 'Réinitialisation…' : 'Réinitialiser'}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="app-column app-column--secondary">
              <ManualEvacuationPanel
                manualActive={manualActive}
                reason={snapshot?.manualEvacuationReason}
                onStart={(reason) => sdk.startManualEvacuation(reason)}
                onStop={(reason) => sdk.stopManualEvacuation(reason)}
              />

              <div className="card actions-card">
                <div className="card__header">
                  <h2 className="card__title">Actions rapides</h2>
                  <p className="card__description">Déclenchez, acquittez ou réinitialisez les séquences en un clic.</p>
                </div>
                <div className="action-grid">
                  <button
                    className="btn btn--secondary"
                    onClick={handleAcknowledge}
                    disabled={ackPending}
                    aria-busy={ackPending}
                  >
                    {ackPending ? 'Acquittement…' : 'Acquit Process'}
                  </button>
                  <button
                    className="btn btn--ghost"
                    onClick={handleClearAck}
                    disabled={clearPending}
                    aria-busy={clearPending}
                  >
                    {clearPending ? 'Nettoyage…' : "Effacer l'acquit"}
                  </button>
                  <button
                    className="btn btn--warning"
                    onClick={handleSimulateDm}
                    disabled={simulateDmPending}
                    aria-busy={simulateDmPending}
                  >
                    {simulateDmPending ? 'Simulation…' : 'Simuler DM ZF1'}
                  </button>
                  <button
                    className="btn btn--secondary"
                    onClick={handleSimulateDai}
                    disabled={simulateDaiPending}
                    aria-busy={simulateDaiPending}
                  >
                    {simulateDaiPending ? 'Détection…' : 'Simuler DAI ZF1'}
                  </button>
                  <button
                    className="btn btn--success"
                    onClick={handleResetSystem}
                    disabled={resetPending}
                    aria-busy={resetPending}
                  >
                    {resetPending ? 'Reset en cours…' : 'Demander un reset'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="configuration" className="console-section">
          <div className="section-header">
            <h2 className="section-header__title">Paramètres & accès</h2>
            <p className="section-header__subtitle">
              Configurez les déclencheurs automatiques et sécurisez l'accès opérateur.
            </p>
          </div>
          <div className="configuration-grid">
            <div className="card config-card">
              <div className="card__header">
                <h2 className="card__title">Paramétrage du site</h2>
                <p className="card__description">Ajustez les contraintes d'exploitation et le comportement des acquits.</p>
              </div>
              <form className="form-grid" onSubmit={handleConfigSubmit}>
                <label className="form-field">
                  <span className="form-field__label">Délai T+5 (ms)</span>
                  <input
                    name="delay"
                    type="number"
                    min={1000}
                    defaultValue={config?.evacOnDMDelayMs ?? 300000}
                    className="text-input"
                  />
                </label>
                <label className="toggle-field">
                  <input name="evacOnDAI" type="checkbox" defaultChecked={config?.evacOnDAI ?? false} />
                  <span>Évacuation immédiate sur détection automatique</span>
                </label>
                <label className="toggle-field">
                  <input name="processAckRequired" type="checkbox" defaultChecked={config?.processAckRequired ?? true} />
                  <span>Acquit Process obligatoire</span>
                </label>
                <button type="submit" className="btn btn--primary">
                  Appliquer la configuration
                </button>
              </form>
            </div>

            <div className="card access-card">
              <div className="card__header">
                <h2 className="card__title">Codes d'accès SSI</h2>
                <p className="card__description">
                  Définissez les codes d'accès des niveaux opérateur. Les codes sont appliqués instantanément au poste apprenant.
                </p>
              </div>
              {accessCodesError && <p className="card__alert">{accessCodesError}</p>}
              {accessCodesFeedback && !accessCodesError && <p className="card__feedback">{accessCodesFeedback}</p>}
              {accessCodesLoading ? (
                <p className="access-card__loading">Chargement des codes en cours…</p>
              ) : (
                <div className="access-card__grid">
                  {[2, 3].map((level) => {
                    const current = accessCodeMap.get(level);
                    const lastUpdate = current?.updatedAt
                      ? formatTime(new Date(current.updatedAt).getTime())
                      : '—';
                    return (
                      <form
                        key={level}
                        className="access-code-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          handleAccessCodeSubmit(level);
                        }}
                      >
                        <div className="access-code-form__header">
                          <span className="access-code-form__level">Niveau {level}</span>
                          <span className="access-code-form__timestamp">Dernière mise à jour : {lastUpdate}</span>
                        </div>
                        <label className="access-code-field">
                          <span>Code</span>
                          <input
                            value={codeInputs[level] ?? ''}
                            onChange={(event) => handleAccessCodeInputChange(level, event.target.value)}
                            placeholder="4 à 8 chiffres"
                            className="text-input"
                            maxLength={8}
                          />
                        </label>
                        <button
                          type="submit"
                          className="btn btn--primary"
                          disabled={updatingCodeLevel === level}
                          aria-busy={updatingCodeLevel === level}
                        >
                          {updatingCodeLevel === level ? 'Enregistrement…' : 'Enregistrer'}
                        </button>
                      </form>
                    );
                  })}
                </div>
              )}
              <p className="access-card__hint">
                Le niveau 1 reste accessible sans code. Le niveau 3 est réservé aux équipes de maintenance et n'est pas utilisable
                depuis le poste apprenant.
              </p>
            </div>
          </div>
        </section>

        <section id="trainee" className="console-section">
          <div className="section-header">
            <h2 className="section-header__title">Poste apprenant</h2>
            <p className="section-header__subtitle">
              Ajustez l'interface de l'apprenant pour suivre votre déroulé pédagogique.
            </p>
          </div>
          <div className="card layout-card">
            <div className="card__header">
              <h2 className="card__title">Disposition du poste apprenant</h2>
              <p className="card__description">
                Réorganisez les cartes visuelles et panneaux pour qu&apos;ils correspondent à votre déroulé pédagogique.
              </p>
            </div>
            {layoutLoading ? (
              <p className="layout-card__placeholder">Chargement de la disposition…</p>
            ) : (
              <>
                {layoutError && <p className="layout-card__error">{layoutError}</p>}
                <div className="layout-grid">
                  <div className="layout-section">
                    <h3 className="layout-section__title">Synoptique CMSI</h3>
                    <p className="layout-section__subtitle">Ordre des cartes lumineuses.</p>
                    <ul className="layout-list">
                      {layoutDraft.boardModuleOrder.map((id, index) => {
                        const isHidden = layoutDraft.boardModuleHidden?.includes(id) ?? false;
                        const itemClasses = ['layout-list__item'];
                        if (isHidden) {
                          itemClasses.push('layout-list__item--hidden');
                        }
                        return (
                          <li
                            key={id}
                            className={itemClasses.join(' ')}
                          >
                            <div className="layout-list__info">
                              <span className="layout-list__label">{BOARD_TILE_LABELS[id] ?? id}</span>
                              {isHidden && <span className="layout-list__badge">Masquée</span>}
                            </div>
                            <div className="layout-list__actions">
                              <button
                                type="button"
                                className="layout-list__button"
                                onClick={() => handleLayoutMove('board', id, -1)}
                                disabled={index === 0 || layoutSaving}
                              >
                                Monter
                              </button>
                              <button
                                type="button"
                                className="layout-list__button"
                                onClick={() => handleLayoutMove('board', id, 1)}
                                disabled={index === layoutDraft.boardModuleOrder.length - 1 || layoutSaving}
                              >
                                Descendre
                              </button>
                              <button
                                type="button"
                                className="layout-list__button layout-list__button--toggle"
                                onClick={() => handleLayoutToggleVisibility('board', id)}
                                disabled={layoutSaving}
                              >
                                {isHidden ? 'Afficher' : 'Masquer'}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  <div className="layout-section">
                    <h3 className="layout-section__title">Bandeau de commandes</h3>
                    <p className="layout-section__subtitle">Séquence des actions disponibles.</p>
                    <ul className="layout-list">
                      {layoutDraft.controlButtonOrder.map((id, index) => {
                        const isHidden = layoutDraft.controlButtonHidden?.includes(id) ?? false;
                        const itemClasses = ['layout-list__item'];
                        if (isHidden) {
                          itemClasses.push('layout-list__item--hidden');
                        }
                        return (
                          <li
                            key={id}
                            className={itemClasses.join(' ')}
                          >
                            <div className="layout-list__info">
                              <span className="layout-list__label">{CONTROL_BUTTON_LABELS[id] ?? id}</span>
                              {isHidden && <span className="layout-list__badge">Masquée</span>}
                            </div>
                            <div className="layout-list__actions">
                              <button
                                type="button"
                                className="layout-list__button"
                                onClick={() => handleLayoutMove('controls', id, -1)}
                                disabled={index === 0 || layoutSaving}
                              >
                                Monter
                              </button>
                              <button
                                type="button"
                                className="layout-list__button"
                                onClick={() => handleLayoutMove('controls', id, 1)}
                                disabled={index === layoutDraft.controlButtonOrder.length - 1 || layoutSaving}
                              >
                                Descendre
                              </button>
                              <button
                                type="button"
                                className="layout-list__button layout-list__button--toggle"
                                onClick={() => handleLayoutToggleVisibility('controls', id)}
                                disabled={layoutSaving}
                              >
                                {isHidden ? 'Afficher' : 'Masquer'}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  <div className="layout-section">
                    <h3 className="layout-section__title">Panneaux latéraux</h3>
                    <p className="layout-section__subtitle">Priorité des informations affichées.</p>
                    <ul className="layout-list">
                      {layoutDraft.sidePanelOrder.map((id, index) => {
                        const isHidden = layoutDraft.sidePanelHidden?.includes(id) ?? false;
                        const itemClasses = ['layout-list__item'];
                        if (isHidden) {
                          itemClasses.push('layout-list__item--hidden');
                        }
                        return (
                          <li
                            key={id}
                            className={itemClasses.join(' ')}
                          >
                            <div className="layout-list__info">
                              <span className="layout-list__label">{SIDE_PANEL_LABELS[id] ?? id}</span>
                              {isHidden && <span className="layout-list__badge">Masquée</span>}
                            </div>
                            <div className="layout-list__actions">
                              <button
                                type="button"
                                className="layout-list__button"
                                onClick={() => handleLayoutMove('panels', id, -1)}
                                disabled={index === 0 || layoutSaving}
                              >
                                Monter
                              </button>
                              <button
                                type="button"
                                className="layout-list__button"
                                onClick={() => handleLayoutMove('panels', id, 1)}
                                disabled={index === layoutDraft.sidePanelOrder.length - 1 || layoutSaving}
                              >
                                Descendre
                              </button>
                              <button
                                type="button"
                                className="layout-list__button layout-list__button--toggle"
                                onClick={() => handleLayoutToggleVisibility('panels', id)}
                                disabled={layoutSaving}
                              >
                                {isHidden ? 'Afficher' : 'Masquer'}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
                <div className="layout-card__actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={handleLayoutRestoreSaved}
                    disabled={layoutSaving || !layoutConfig}
                  >
                    Rétablir la disposition enregistrée
                  </button>
                  <button
                    type="button"
                    className="btn btn--outline"
                    onClick={handleLayoutResetToDefault}
                    disabled={layoutSaving}
                  >
                    Réinitialiser aux valeurs par défaut
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={handleLayoutSave}
                    disabled={layoutSaving || !isLayoutDirty}
                  >
                    {layoutSaving ? 'Enregistrement…' : 'Enregistrer la disposition'}
                  </button>
                </div>
                {layoutFeedback && <p className="layout-card__feedback">{layoutFeedback}</p>}
              </>
            )}
          </div>
        </section>

        <section id="topology" className="console-section">
          <div className="section-header">
            <h2 className="section-header__title">Cartographie du site</h2>
            <p className="section-header__subtitle">
              Visualisez les zones et dispositifs importés depuis l'Admin Studio.
            </p>
          </div>
          <div className="card topology-card">
            <div className="card__header">
              <h2 className="card__title">Cartographie du site</h2>
              <p className="card__description">
                Synchronisez-vous avec l'Admin Studio : zones et dispositifs configurés pour l'exercice.
              </p>
            </div>
            {topologyLoading ? (
              <p className="topology-placeholder">Chargement de la topologie…</p>
            ) : topologyError ? (
              <p className="topology-error">{topologyError}</p>
            ) : hasTopologyData ? (
              <>
                {topology?.zones.length ? (
                  <ul className="topology-zone-list">
                    {topology.zones.map((zone) => {
                      const zoneDevices = devicesByZone.get(zone.id) ?? [];
                      return (
                        <li key={zone.id} className="topology-zone">
                          <div className="topology-zone__header">
                            <div className="topology-zone__title">
                              <span className="topology-zone__name">{zone.label}</span>
                              <span className="topology-zone__id">#{zone.id}</span>
                            </div>
                            <span className="topology-zone__kind">{formatZoneKind(zone.kind)}</span>
                          </div>
                          {zoneDevices.length === 0 ? (
                            <p className="topology-zone__empty">Aucun dispositif associé.</p>
                          ) : (
                            <ul className="topology-device-list">
                              {zoneDevices.map((device) => {
                                const coords = extractDeviceCoords(device);
                                return (
                                  <li key={device.id} className="topology-device">
                                    <span className={deviceBadgeClass(device.kind)}>
                                      {formatDeviceKind(device.kind)}
                                    </span>
                                    <div className="topology-device__meta">
                                      <span className="topology-device__label">{resolveDeviceLabel(device)}</span>
                                      {coords && <span className="topology-device__coords">{coords}</span>}
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {unassignedDevices.length > 0 && (
                  <div className="topology-unassigned">
                    <span className="topology-unassigned__label">Dispositifs sans zone</span>
                    <ul className="topology-device-list">
                      {unassignedDevices.map((device) => {
                        const coords = extractDeviceCoords(device);
                        return (
                          <li key={device.id} className="topology-device">
                            <span className={deviceBadgeClass(device.kind)}>{formatDeviceKind(device.kind)}</span>
                            <div className="topology-device__meta">
                              <span className="topology-device__label">{resolveDeviceLabel(device)}</span>
                              {coords && <span className="topology-device__coords">{coords}</span>}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <p className="topology-empty">Aucun plan n'a encore été défini dans l'Admin Studio.</p>
            )}
          </div>
        </section>

        <section id="scenarios" className="console-section">
          <div className="section-header">
            <h2 className="section-header__title">Scénarios pédagogiques</h2>
            <p className="section-header__subtitle">
              Composez vos exercices DAI/DM et diffusez-les instantanément auprès du poste apprenant.
            </p>
          </div>
          <div className="card scenario-card">
            <div className="card__header">
              <h2 className="card__title">Scénarios personnalisés</h2>
              <p className="card__description">Composez vos exercices DAI/DM et diffusez-les instantanément auprès du poste apprenant.</p>
            </div>
            <div className="scenario-status">
              <div className="scenario-status__meta">
                <span className="scenario-status__label">Scénario courant</span>
                <strong className="scenario-status__name">
                  {scenarioStatus.scenario?.name ?? 'Aucun scénario actif'}
                </strong>
              </div>
              <div className={`scenario-status__badge scenario-status__badge--${scenarioStatus.status}`}>
                {scenarioStateLabel}
              </div>
              <div className="scenario-status__next">
                <span className="scenario-status__hint">Prochain événement</span>
                <span>{nextScenarioEvent}</span>
              </div>
              <div className="scenario-status__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={handleScenarioComplete}
                  disabled={!scenarioIsRunning}
                >
                  Terminer le scénario
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={handleScenarioStop}
                  disabled={!scenarioIsActive}
                >
                  Arrêter / annuler le scénario
                </button>
              </div>
            </div>
            <div className="scenario-layout">
              <aside className="scenario-sidebar">
                <div className="scenario-sidebar__header">
                  <h3 className="scenario-sidebar__title">Bibliothèque</h3>
                  <div className="scenario-sidebar__actions">
                    <button type="button" className="btn btn--ghost" onClick={handleScenarioImportClick}>
                      Importer
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={handleScenarioResetForm}>
                      Nouveau
                    </button>
                  </div>
                  <input
                    ref={scenarioFileInputRef}
                    type="file"
                    accept="application/json,.json"
                    onChange={handleScenarioFileChange}
                    style={{ display: 'none' }}
                  />
                </div>
                <ul className="scenario-list">
                  {scenarios.length === 0 && <li className="scenario-list__empty">Aucun scénario enregistré.</li>}
                  {scenarios.map((scenario) => {
                    const isActive = scenarioStatus.scenario?.id === scenario.id;
                    return (
                      <li key={scenario.id} className={`scenario-list__item ${isActive ? 'is-active' : ''}`}>
                        <div className="scenario-list__meta">
                          <span className="scenario-list__name">{scenario.name}</span>
                          <span className="scenario-list__count">{scenario.events.length} évènement(s)</span>
                        </div>
                        <div className="scenario-list__actions">
                          <button
                            type="button"
                            className="btn btn--ghost"
                            onClick={() => handleScenarioPreload(scenario.id)}
                            disabled={
                              scenarioPreloadingId === scenario.id ||
                              scenarioIsRunning ||
                              (scenarioIsReady && isActive)
                            }
                            aria-busy={scenarioPreloadingId === scenario.id}
                          >
                            {scenarioPreloadingId === scenario.id
                              ? 'Préchargement…'
                              : scenarioIsReady && isActive
                              ? 'Préchargé'
                              : 'Précharger'}
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            onClick={() => handleScenarioRun(scenario.id)}
                            disabled={(scenarioIsRunning && isActive) || scenarioPreloadingId === scenario.id}
                          >
                            Lancer
                          </button>
                          <button
                            type="button"
                            className="btn btn--outline"
                            onClick={() => handleScenarioEdit(scenario)}
                            disabled={scenarioLoadingId === scenario.id}
                            aria-busy={scenarioLoadingId === scenario.id}
                          >
                            {scenarioLoadingId === scenario.id ? 'Chargement…' : 'Modifier'}
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            onClick={() => handleScenarioExport(scenario)}
                          >
                            Exporter
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost scenario-delete"
                            onClick={() => handleScenarioDelete(scenario.id)}
                            disabled={scenarioDeleting === scenario.id}
                            aria-busy={scenarioDeleting === scenario.id}
                          >
                            Supprimer
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </aside>
              <div className="scenario-editor">
                {scenarioTopology?.plan?.image && (
                  <section className="scenario-plan" aria-label="Plan interactif du site">
                    <div className="scenario-plan__header">
                      <div>
                        <h3 className="scenario-plan__title">Plan interactif</h3>
                        {planMetadata.planName && (
                          <p className="scenario-plan__subtitle">{planMetadata.planName}</p>
                        )}
                      </div>
                    </div>
                    <div className="scenario-plan__stage">
                      <img
                        src={scenarioTopology.plan.image}
                        alt={planMetadata.planName ? `Plan ${planMetadata.planName}` : 'Plan du site'}
                      />
                      {scenarioTopology.devices.map((device) => {
                        const position = getDevicePosition(device);
                        if (!position) {
                          return null;
                        }
                        const zoneLabel = device.zoneId ? ` (${device.zoneId})` : '';
                        const label = `${formatDeviceKind(device.kind)} · ${resolveDeviceLabel(device)}${zoneLabel}`;
                        const active = isDeviceActive(device, snapshot);
                        return (
                          <span
                            key={device.id}
                            className={`scenario-plan__marker scenario-plan__marker--${device.kind.toLowerCase()}${
                              active ? ' is-active' : ''
                            }`}
                            style={{ left: `${position.x}%`, top: `${position.y}%` }}
                            title={label}
                            aria-label={label}
                          >
                            {formatDeviceKind(device.kind)}
                          </span>
                        );
                      })}
                    </div>
                    {planMetadata.notes.length > 0 && (
                      <div className="scenario-plan__notes">
                        <h4>Repères site</h4>
                        <ul>
                          {planMetadata.notes.map((note) => (
                            <li key={note}>{note}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>
                )}
                <form className="scenario-form" onSubmit={handleScenarioSubmit}>
                  <div className="scenario-form__row">
                    <label className="scenario-form__field">
                      <span>Nom du scénario</span>
                      <input
                        value={draftScenario.name}
                      onChange={(event) => handleScenarioNameChange(event.target.value)}
                      placeholder="Ex : Exercice évacuation étage 2"
                      className="text-input"
                    />
                  </label>
                  <label className="scenario-form__field">
                    <span>Description</span>
                    <textarea
                      value={draftScenario.description ?? ''}
                      onChange={(event) => handleScenarioDescriptionChange(event.target.value)}
                      placeholder="Objectifs, consignes pédagogiques…"
                      className="text-area"
                      rows={2}
                    />
                  </label>
                </div>
                <div className="scenario-form__row scenario-form__row--single">
                  <div className="scenario-form__field">
                    <span>Plan interactif associé</span>
                    <div className="scenario-form__topology">
                      <p className="scenario-form__topology-summary">
                        {draftScenario.topology
                          ? `Plan ${
                              draftPlanMetadata.planName
                                ? `« ${draftPlanMetadata.planName} »`
                                : 'sans nom'
                            } sauvegardé avec le scénario.`
                          : "Aucun plan n'est actuellement associé à ce scénario."}
                      </p>
                      <p className="scenario-form__topology-hint">
                        {draftScenario.topology
                          ? 'Associez de nouveau la cartographie du site pour remplacer le plan lié.'
                          :
                              'Utilisez le plan importé dans l’onglet Cartographie pour le lier définitivement à ce scénario.'}
                      </p>
                      <div className="scenario-form__topology-actions">
                        <button
                          type="button"
                          className="btn btn--outline"
                          onClick={handleScenarioAttachTopology}
                          disabled={!topology}
                        >
                          Associer le plan actuel
                        </button>
                        {draftScenario.topology && (
                          <button
                            type="button"
                            className="btn btn--ghost"
                            onClick={handleScenarioDetachTopology}
                          >
                            Retirer le plan
                          </button>
                        )}
                      </div>
                    </div>
                </div>
              </div>
              <div className="scenario-form__row scenario-form__row--single">
                <div className="scenario-form__field">
                  <span>Réarmement manuel autorisé</span>
                  <div className="scenario-form__manual-reset">
                    <div className="scenario-manual-reset__modes">
                      <label className="scenario-manual-reset__mode">
                        <input
                          type="radio"
                          name="scenario-manual-reset-mode"
                          value="all"
                          checked={draftScenario.manualResetMode === 'all'}
                          onChange={() => handleScenarioManualResetModeChange('all')}
                        />
                        <span>Tous les dispositifs déclenchés</span>
                      </label>
                      <label className="scenario-manual-reset__mode">
                        <input
                          type="radio"
                          name="scenario-manual-reset-mode"
                          value="custom"
                          checked={draftScenario.manualResetMode === 'custom'}
                          onChange={() => handleScenarioManualResetModeChange('custom')}
                        />
                        <span>Sélection personnalisée</span>
                      </label>
                    </div>
                    {draftScenario.manualResetMode === 'custom' && (
                      <div className="scenario-manual-reset__lists">
                        <div className="scenario-manual-reset__group">
                          <span className="scenario-manual-reset__group-title">Déclencheurs manuels</span>
                          {manualResetOptions.dm.length === 0 ? (
                            <p className="scenario-manual-reset__empty">Aucun DM cartographié.</p>
                          ) : (
                            manualResetOptions.dm.map((option) => (
                              <label
                                key={`manual-reset-dm-${option.value}`}
                                className="scenario-manual-reset__option"
                              >
                                <input
                                  type="checkbox"
                                  checked={draftScenario.manualResettable.dmZones.includes(option.value)}
                                  onChange={() => handleScenarioManualResetToggle('DM', option.value)}
                                />
                                <span>{option.label}</span>
                              </label>
                            ))
                          )}
                        </div>
                        <div className="scenario-manual-reset__group">
                          <span className="scenario-manual-reset__group-title">Détecteurs automatiques</span>
                          {manualResetOptions.dai.length === 0 ? (
                            <p className="scenario-manual-reset__empty">Aucun DAI cartographié.</p>
                          ) : (
                            manualResetOptions.dai.map((option) => (
                              <label
                                key={`manual-reset-dai-${option.value}`}
                                className="scenario-manual-reset__option"
                              >
                                <input
                                  type="checkbox"
                                  checked={draftScenario.manualResettable.daiZones.includes(option.value)}
                                  onChange={() => handleScenarioManualResetToggle('DAI', option.value)}
                                />
                                <span>{option.label}</span>
                              </label>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="scenario-form__row scenario-form__row--single">
                <div className="scenario-form__field">
                  <span>Bandes son d'évacuation</span>
                  <p className="scenario-audio__hint">
                    Sélectionnez les sons diffusés lorsque l'évacuation démarre automatiquement ou manuellement.
                  </p>
                  <div className="scenario-audio">
                    <div className="scenario-audio__item">
                      <div className="scenario-audio__meta">
                        <strong>Déclenchement automatique</strong>
                        <span>Diffusé lors d'une évacuation programmée dans le scénario.</span>
                      </div>
                      <div className="scenario-audio__actions">
                        {draftScenario.evacuationAudio?.automatic ? (
                          <>
                            <span className="scenario-audio__filename">
                              {draftScenario.evacuationAudio.automatic.name}
                            </span>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              onClick={() => handleScenarioEvacuationAudioSelect('automatic')}
                            >
                              Remplacer
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              onClick={() => handleScenarioEvacuationAudioClear('automatic')}
                            >
                              Retirer
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn btn--outline"
                            onClick={() => handleScenarioEvacuationAudioSelect('automatic')}
                          >
                            Ajouter un son
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="scenario-audio__item">
                      <div className="scenario-audio__meta">
                        <strong>Déclenchement manuel</strong>
                        <span>Utilisé quand l'apprenant active l'évacuation manuellement.</span>
                      </div>
                      <div className="scenario-audio__actions">
                        {draftScenario.evacuationAudio?.manual ? (
                          <>
                            <span className="scenario-audio__filename">
                              {draftScenario.evacuationAudio.manual.name}
                            </span>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              onClick={() => handleScenarioEvacuationAudioSelect('manual')}
                            >
                              Remplacer
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              onClick={() => handleScenarioEvacuationAudioClear('manual')}
                            >
                              Retirer
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn btn--outline"
                            onClick={() => handleScenarioEvacuationAudioSelect('manual')}
                          >
                            Ajouter un son
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  <input
                    ref={scenarioAutomaticAudioInputRef}
                    type="file"
                    accept="audio/*"
                    style={{ display: 'none' }}
                    onChange={(event) => handleScenarioEvacuationAudioChange('automatic', event)}
                  />
                  <input
                    ref={scenarioManualAudioInputRef}
                    type="file"
                    accept="audio/*"
                    style={{ display: 'none' }}
                    onChange={(event) => handleScenarioEvacuationAudioChange('manual', event)}
                  />
                </div>
              </div>
              {scenarioZoneOptions.length > 0 && (
                <datalist id={SCENARIO_ZONE_DATALIST_ID}>
                  {scenarioZoneOptions.map((option) => (
                    <option key={option.value} value={option.value} label={option.label} />
                  ))}
                  </datalist>
                )}
                <div className="scenario-events">
                  <div className="scenario-events__header">
                    <h4>Évènements programmés</h4>
                    <button type="button" className="btn btn--ghost" onClick={handleScenarioAddEvent}>
                      Ajouter un événement
                    </button>
                  </div>
                  {sortedDraftEvents.length === 0 && (
                    <p className="scenario-events__empty">Ajoutez une action pour démarrer la construction du scénario.</p>
                  )}
                  {sortedDraftEvents.map((eventDraft, index) => {
                    const offsetValue = Number.isFinite(eventDraft.offset) ? eventDraft.offset : 0;
                    const zoneEvent =
                      eventDraft.type === 'DM_TRIGGER' ||
                      eventDraft.type === 'DM_RESET' ||
                      eventDraft.type === 'DAI_TRIGGER' ||
                      eventDraft.type === 'DAI_RESET';
                    const reasonEvent = eventDraft.type === 'MANUAL_EVAC_START' || eventDraft.type === 'MANUAL_EVAC_STOP';
                    const ackEvent = eventDraft.type === 'PROCESS_ACK';
                    const zoneId =
                      'zoneId' in eventDraft ? ((eventDraft as { zoneId?: string }).zoneId ?? '').toUpperCase() : '';
                    const zoneMetadata =
                      zoneId && scenarioZoneOptions.length > 0
                        ? scenarioZoneOptions.find((option) => option.value === zoneId)
                        : undefined;
                    return (
                      <div key={eventDraft.id} className="scenario-event-row">
                        <div className="scenario-event-row__header">
                          <div className="scenario-event-row__title">
                            <span className="scenario-event-row__index">#{index + 1}</span>
                            <label className="scenario-event-field scenario-event-field--type">
                              <span>Action</span>
                              <select
                                value={eventDraft.type}
                                onChange={(input) =>
                                  handleScenarioEventTypeChange(
                                    eventDraft.id,
                                    input.target.value as ScenarioEvent['type'],
                                  )
                                }
                              >
                                {SCENARIO_EVENT_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                          <div className="scenario-event-row__meta">
                            <label className="scenario-event-field scenario-event-field--offset">
                              <span>Offset (s)</span>
                              <input
                                type="number"
                                min={0}
                                step={0.1}
                                value={offsetValue}
                                onChange={(input) => {
                                  const value = Number.parseFloat(input.target.value);
                                  handleScenarioEventOffsetChange(
                                    eventDraft.id,
                                    Number.isNaN(value) ? 0 : value,
                                  );
                                }}
                              />
                            </label>
                            <button
                              type="button"
                              className="scenario-event-remove"
                              onClick={() => handleScenarioRemoveEvent(eventDraft.id)}
                              aria-label={`Supprimer l'événement ${index + 1}`}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                        <div className="scenario-event-row__content">
                          {zoneEvent && (
                            <label className="scenario-event-field scenario-event-field--zone">
                              <span>Zone</span>
                              <input
                                value={zoneId}
                                list={scenarioZoneOptions.length > 0 ? SCENARIO_ZONE_DATALIST_ID : undefined}
                                onChange={(input) => handleScenarioEventZoneChange(eventDraft.id, input.target.value)}
                                placeholder={scenarioZoneOptions.length > 0 ? 'Sélectionner une zone' : 'ZF1'}
                              />
                              {scenarioZoneOptions.length > 0 && (
                                <span className="scenario-event-field__hint">
                                  {zoneMetadata
                                    ? `${zoneMetadata.label} · ${formatZoneKind(zoneMetadata.kind)}`
                                    : 'Saisissez ou choisissez une zone importée'}
                                </span>
                              )}
                            </label>
                          )}
                          {reasonEvent && (
                            <label className="scenario-event-field scenario-event-field--reason">
                              <span>Motif</span>
                              <input
                                value={(eventDraft as { reason?: string }).reason ?? ''}
                                onChange={(input) => handleScenarioEventReasonChange(eventDraft.id, input.target.value)}
                                placeholder="Ex : Exercice, dérangement"
                              />
                            </label>
                          )}
                          {ackEvent && (
                            <label className="scenario-event-field scenario-event-field--acked">
                              <span>Opérateur</span>
                              <input
                                value={(eventDraft as { ackedBy?: string }).ackedBy ?? ''}
                                onChange={(input) => handleScenarioEventAckedByChange(eventDraft.id, input.target.value)}
                                placeholder="trainer / trainee"
                              />
                            </label>
                          )}
                          <label className="scenario-event-field scenario-event-field--label">
                            <span>Libellé</span>
                            <input
                              value={eventDraft.label ?? ''}
                              onChange={(input) => handleScenarioEventLabelChange(eventDraft.id, input.target.value)}
                              placeholder="Note pédagogique (optionnel)"
                            />
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
                  {scenarioFeedback && <p className="scenario-feedback">{scenarioFeedback}</p>}
                  {scenarioError && <p className="scenario-error">{scenarioError}</p>}
                  <div className="scenario-form__actions">
                    <button
                      type="submit"
                      className="btn btn--primary"
                      disabled={scenarioSaving}
                      aria-busy={scenarioSaving}
                    >
                      {scenarioSaving
                        ? 'Enregistrement…'
                        : editingScenarioId
                        ? 'Mettre à jour le scénario'
                        : 'Créer le scénario'}
                    </button>
                    {editingScenarioId && (
                      <button type="button" className="btn btn--ghost" onClick={handleScenarioResetForm}>
                        Réinitialiser le formulaire
                      </button>
                    )}
                  </div>
                </form>
              </div>
            </div>
          </div>
        </section>

        <section id="sessions" className="console-section">
          <div className="section-header">
            <h2 className="section-header__title">Sessions & apprenants</h2>
            <p className="section-header__subtitle">
              Pilotez les participants et conservez une trace des objectifs et axes de progression.
            </p>
          </div>
          <div className="sessions-grid">
            <div className="card users-card">
              <div className="card__header">
                <h2 className="card__title">Gestion des utilisateurs</h2>
                <p className="card__description">
                  Enregistrez vos apprenants et formateurs afin de suivre les sessions individuelles.
                </p>
              </div>
              {usersError && <p className="card__alert">{usersError}</p>}
              {userActionError && <p className="card__alert">{userActionError}</p>}
              {userFormFeedback && <p className="card__feedback">{userFormFeedback}</p>}
              <form className="user-form" onSubmit={handleUserCreate}>
                <div className="user-form__row">
                  <label className="user-form__field">
                    <span>Nom complet</span>
                    <input
                      value={userForm.fullName}
                      onChange={(event) => handleUserFieldChange('fullName', event.target.value)}
                      placeholder="Ex : Marie Dupont"
                      className="text-input"
                      required
                    />
                  </label>
                  <label className="user-form__field">
                    <span>Email (optionnel)</span>
                    <input
                      type="email"
                      value={userForm.email}
                      onChange={(event) => handleUserFieldChange('email', event.target.value)}
                      placeholder="prenom.nom@entreprise.fr"
                      className="text-input"
                    />
                  </label>
                  <label className="user-form__field">
                    <span>Rôle</span>
                    <select
                      value={userForm.role}
                      onChange={(event) => handleUserFieldChange('role', event.target.value)}
                    >
                      <option value="TRAINEE">Apprenant</option>
                      <option value="TRAINER">Formateur</option>
                    </select>
                  </label>
                </div>
                <button type="submit" className="btn btn--primary" disabled={creatingUser} aria-busy={creatingUser}>
                  {creatingUser ? 'Ajout en cours…' : 'Ajouter un utilisateur'}
                </button>
              </form>
              <div className="user-import-controls">
                <p className="user-import-controls__hint">
                  Importez un fichier exporté ou générez une sauvegarde de la liste actuelle.
                </p>
                <div className="user-import-controls__actions">
                  <button type="button" className="btn btn--ghost" onClick={handleUserExport}>
                    Exporter (.json)
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={handleUserImportClick}
                    disabled={userImporting}
                    aria-busy={userImporting}
                  >
                    {userImporting ? 'Import en cours…' : 'Importer (.json)'}
                  </button>
                </div>
                <input
                  ref={userImportInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="user-import-input"
                  onChange={handleUserImportFileChange}
                />
              </div>
              <div className="user-list-wrapper">
                {usersLoading ? (
                  <p className="card__placeholder">Chargement des utilisateurs…</p>
                ) : users.length === 0 ? (
                  <p className="card__placeholder">Aucun utilisateur enregistré pour le moment.</p>
                ) : (
                  <ul className="user-list">
                    {users.map((user) => {
                      const editing = editingUserId === user.id && editingUserDraft;
                      return (
                        <li key={user.id} className="user-list__item">
                          {editing ? (
                            <div className="user-edit">
                              <label className="user-edit__field">
                                <span>Nom</span>
                                <input
                                  value={editingUserDraft.fullName}
                                  onChange={(event) =>
                                    handleUserEditFieldChange('fullName', event.target.value)
                                  }
                                  className="text-input"
                                />
                              </label>
                              <label className="user-edit__field">
                                <span>Email</span>
                                <input
                                  value={editingUserDraft.email}
                                  onChange={(event) =>
                                    handleUserEditFieldChange('email', event.target.value)
                                  }
                                  className="text-input"
                                />
                              </label>
                              <label className="user-edit__field">
                                <span>Rôle</span>
                                <select
                                  value={editingUserDraft.role}
                                  onChange={(event) =>
                                    handleUserEditFieldChange('role', event.target.value)
                                  }
                                >
                                  <option value="TRAINEE">Apprenant</option>
                                  <option value="TRAINER">Formateur</option>
                                </select>
                              </label>
                              <div className="user-edit__actions">
                                <button
                                  type="button"
                                  className="btn btn--primary"
                                  onClick={handleUserEditSubmit}
                                  disabled={userSavingId === user.id}
                                  aria-busy={userSavingId === user.id}
                                >
                                  {userSavingId === user.id ? 'Enregistrement…' : 'Enregistrer'}
                                </button>
                                <button type="button" className="btn btn--ghost" onClick={handleUserEditCancel}>
                                  Annuler
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="user-item">
                              <div className="user-item__info">
                                <span className="user-item__name">{user.fullName}</span>
                                {user.email && <span className="user-item__email">{user.email}</span>}
                                <span className={`user-role-badge user-role-badge--${user.role.toLowerCase()}`}>
                                  {user.role === 'TRAINER' ? 'Formateur' : 'Apprenant'}
                                </span>
                              </div>
                              <div className="user-item__actions">
                                <button type="button" className="btn btn--ghost" onClick={() => handleUserEditInit(user)}>
                                  Modifier
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--ghost user-delete"
                                  onClick={() => handleUserDelete(user.id)}
                                  disabled={userDeletingId === user.id}
                                  aria-busy={userDeletingId === user.id}
                                >
                                  {userDeletingId === user.id ? 'Suppression…' : 'Supprimer'}
                                </button>
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>

            <div className="card current-session-card">
              <div className="card__header">
                <h2 className="card__title">Session en cours</h2>
                <p className="card__description">
                  Démarrez une nouvelle session pour un apprenant ou clôturez l'entraînement actuel.
                </p>
              </div>
              {sessionErrorMessage && <p className="card__alert">{sessionErrorMessage}</p>}
              {sessionFeedback && <p className="card__feedback">{sessionFeedback}</p>}
              {sessionsLoading ? (
                <p className="card__placeholder">Chargement des sessions…</p>
              ) : (
                <div className="current-session">
                  {activeSession ? (
                    <div className="session-summary">
                      <div className="session-summary__header">
                        <h3 className="session-summary__name">{activeSession.name}</h3>
                        <span className={`session-status-badge session-status-badge--${activeSession.status}`}>
                          {activeSession.status === 'active' ? 'En cours' : 'Clôturée'}
                        </span>
                      </div>
                      <dl className="session-summary__meta">
                        <div>
                          <dt>Apprenant</dt>
                          <dd>{activeSession.trainee?.fullName ?? 'Non assigné'}</dd>
                        </div>
                        <div>
                          <dt>Formateur</dt>
                          <dd>{activeSession.trainer?.fullName ?? '—'}</dd>
                        </div>
                        <div>
                          <dt>Début</dt>
                          <dd>{formatDateTime(activeSession.startedAt)}</dd>
                        </div>
                        <div>
                          <dt>Fin</dt>
                          <dd>{formatDateTime(activeSession.endedAt)}</dd>
                        </div>
                        {activeSession.objective && (
                          <div>
                            <dt>Objectifs</dt>
                            <dd>{activeSession.objective}</dd>
                          </div>
                        )}
                        {activeSession.notes && (
                          <div>
                            <dt>Notes</dt>
                            <dd>{activeSession.notes}</dd>
                          </div>
                        )}
                      </dl>
                      {activeSession.improvementAreas.length > 0 && (
                        <div className="session-summary__improvements">
                          <h4>Axes d'amélioration</h4>
                          <ul>
                            {activeSession.improvementAreas.map((area, index) => (
                              <li key={`${area.title}-${index}`}>
                                <strong>{area.title}</strong>
                                {area.description && <span> — {area.description}</span>}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="card__placeholder">Aucune session active pour le moment.</p>
                  )}

                  {(!activeSession || activeSession.status === 'completed') && (
                    <form className="session-start-form" onSubmit={handleSessionCreate}>
                      <h3>Démarrer une session</h3>
                      <div className="session-form__grid">
                        <label className="session-form__field">
                          <span>Nom de la session</span>
                          <input
                            value={sessionForm.name}
                            onChange={(event) => handleSessionFormChange('name', event.target.value)}
                            placeholder="Ex : Exercice évacuation étage 2"
                            className="text-input"
                            required
                          />
                        </label>
                        <label className="session-form__field">
                          <span>Mode</span>
                          <input
                            value={sessionForm.mode}
                            onChange={(event) => handleSessionFormChange('mode', event.target.value)}
                            placeholder="libre / scénario…"
                            className="text-input"
                          />
                        </label>
                        <label className="session-form__field">
                          <span>Apprenant</span>
                          <select
                            value={sessionForm.traineeId}
                            onChange={(event) => handleSessionFormChange('traineeId', event.target.value)}
                          >
                            <option value="">Sélectionner…</option>
                            {traineeOptions.map((user) => (
                              <option key={user.id} value={user.id}>
                                {user.fullName}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="session-form__field">
                          <span>Formateur</span>
                          <select
                            value={sessionForm.trainerId}
                            onChange={(event) => handleSessionFormChange('trainerId', event.target.value)}
                          >
                            <option value="">Sélectionner…</option>
                            {trainerOptions.map((user) => (
                              <option key={user.id} value={user.id}>
                                {user.fullName}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <label className="session-form__field">
                        <span>Objectifs pédagogiques</span>
                        <textarea
                          value={sessionForm.objective}
                          onChange={(event) => handleSessionFormChange('objective', event.target.value)}
                          className="text-area"
                          rows={2}
                          placeholder="Consignes principales, compétences visées…"
                        />
                      </label>
                      <label className="session-form__field">
                        <span>Notes formateur</span>
                        <textarea
                          value={sessionForm.notes}
                          onChange={(event) => handleSessionFormChange('notes', event.target.value)}
                          className="text-area"
                          rows={2}
                          placeholder="Informations complémentaires (optionnel)"
                        />
                      </label>
                      <button type="submit" className="btn btn--primary" disabled={creatingSession} aria-busy={creatingSession}>
                        {creatingSession ? 'Création…' : 'Démarrer la session'}
                      </button>
                    </form>
                  )}

                  {activeSession && activeSession.status === 'active' && (
                    <div className="session-close">
                      <h3>Clôturer la session</h3>
                      <label className="session-form__field">
                        <span>Retour formateur</span>
                        <textarea
                          value={closingNotes}
                          onChange={(event) => setClosingNotes(event.target.value)}
                          className="text-area"
                          rows={3}
                          placeholder="Synthèse des points maîtrisés, recommandations…"
                        />
                      </label>
                      <div className="improvement-actions">
                        <span>Axes d'amélioration personnalisés</span>
                        <div className="improvement-actions__buttons">
                          <button
                            type="button"
                            className="btn btn--ghost"
                            onClick={handleGenerateImprovements}
                            disabled={generatingImprovements}
                            aria-busy={generatingImprovements}
                          >
                            {generatingImprovements ? 'Génération…' : 'Générer automatiquement'}
                          </button>
                          <button type="button" className="btn btn--ghost" onClick={handleAddImprovement}>
                            Ajouter un axe
                          </button>
                        </div>
                      </div>
                      {improvementDrafts.length === 0 ? (
                        <p className="improvement-placeholder">Aucun axe défini pour le moment.</p>
                      ) : (
                        <ul className="improvement-list">
                          {improvementDrafts.map((draft) => (
                            <li key={draft.id} className="improvement-item">
                              <input
                                value={draft.title}
                                onChange={(event) => handleImprovementChange(draft.id, 'title', event.target.value)}
                                placeholder="Titre de l'axe"
                                className="text-input"
                              />
                              <textarea
                                value={draft.description}
                                onChange={(event) => handleImprovementChange(draft.id, 'description', event.target.value)}
                                className="text-area"
                                rows={2}
                                placeholder="Détail ou recommandation (optionnel)"
                              />
                              <button
                                type="button"
                                className="btn btn--ghost improvement-remove"
                                onClick={() => handleImprovementRemove(draft.id)}
                              >
                                Retirer
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={handleCloseSession}
                        disabled={closingSession}
                        aria-busy={closingSession}
                      >
                        {closingSession ? 'Clôture en cours…' : 'Clôturer la session'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="card session-history-card">
              <div className="card__header">
                <h2 className="card__title">Historique récent</h2>
                <p className="card__description">
                  Consultez les dernières sessions pour préparer vos debriefings personnalisés.
                </p>
              </div>
              {sessionsError && <p className="card__alert">{sessionsError}</p>}
              {sessionsLoading ? (
                <p className="card__placeholder">Chargement du journal des sessions…</p>
              ) : recentSessions.length === 0 ? (
                <p className="card__placeholder">Aucune session enregistrée.</p>
              ) : (
                <ul className="session-history">
                  {recentSessions.map((sessionItem) => (
                    <li
                      key={sessionItem.id}
                      className={`session-history__item session-history__item--${sessionItem.status}`}
                    >
                      <div className="session-history__header">
                        <span className="session-history__name">{sessionItem.name}</span>
                        <span className="session-history__badge">
                          {sessionItem.status === 'active' ? 'En cours' : 'Clôturée'}
                        </span>
                      </div>
                      <div className="session-history__meta">
                        <span>Apprenant : {sessionItem.trainee?.fullName ?? 'Non défini'}</span>
                        <span>Début : {formatDateTime(sessionItem.startedAt)}</span>
                        <span>Fin : {formatDateTime(sessionItem.endedAt)}</span>
                      </div>
                      {sessionItem.improvementAreas.length > 0 && (
                        <ul className="session-history__improvements">
                          {sessionItem.improvementAreas.map((area, index) => (
                            <li key={`${sessionItem.id}-area-${index}`}>
                              <strong>{area.title}</strong>
                              {area.description && <span> — {area.description}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        <section id="journal" className="console-section">
          <div className="section-header">
            <h2 className="section-header__title">Journal d'événements</h2>
            <p className="section-header__subtitle">
              Conservez une trace synthétique des dernières interactions pour débriefer la session.
            </p>
          </div>
          <div className="card log-card">
            <div className="card__header">
              <h2 className="card__title">Journal en direct</h2>
              <p className="card__description">Historique condensé des événements récents côté CMSI et scénarios.</p>
            </div>
            <ul className="log-list">
              {events.length === 0 && <li className="log-list__empty">Aucun événement pour le moment.</li>}
              {events.map((entry) => (
                <li key={entry} className="log-entry">
                  {entry}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
    </div>
  );
}

function deriveTone(snapshot: DomainSnapshot | null): 'neutral' | 'warning' | 'critical' | 'success' {
  if (!snapshot) return 'neutral';
  switch (snapshot.cmsi.status) {
    case 'EVAC_PENDING':
      return 'warning';
    case 'EVAC_ACTIVE':
      return 'critical';
    case 'EVAC_SUSPENDED':
    case 'SAFE_HOLD':
      return 'success';
    default:
      return 'neutral';
  }
}

function formatDateTime(iso?: string | null): string {
  if (!iso) {
    return '—';
  }
  try {
    return new Date(iso).toLocaleString();
  } catch (error) {
    console.error('Failed to format date', error);
    return iso;
  }
}
