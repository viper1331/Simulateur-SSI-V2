import { useCallback, useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { ManualEvacuationPanel, StatusTile, TimelineBadge } from '@simu-ssi/shared-ui';
import {
  SsiSdk,
  DEFAULT_TRAINEE_LAYOUT,
  type AccessCode,
  type ScenarioDefinition,
  type ScenarioEvent,
  type ScenarioPayload,
  type ScenarioRunnerSnapshot,
  type SiteConfig,
  type SiteDevice,
  type SiteTopology,
  siteTopologySchema,
  traineeLayoutSchema,
  type TraineeLayoutConfig,
} from '@simu-ssi/sdk';

interface CmsiStateData {
  status: string;
  deadline?: number;
  suspendFlag?: boolean;
  manual?: boolean;
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
  events: ScenarioEventDraft[];
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
  instructions: 'Consignes Apprenant',
};

const NAVIGATION_SECTIONS = [
  { id: 'overview', label: "Vue d'ensemble" },
  { id: 'operations', label: 'Opérations en direct' },
  { id: 'configuration', label: 'Paramètres & accès' },
  { id: 'trainee', label: 'Poste apprenant' },
  { id: 'topology', label: 'Cartographie' },
  { id: 'scenarios', label: 'Scénarios pédagogiques' },
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

function formatCmsiStatus(status?: string) {
  if (!status) return '—';
  return CMSI_STATUS_LABELS[status] ?? status;
}

function formatTime(iso?: number) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString();
}

function translateScenarioStatus(status: ScenarioRunnerSnapshot['status']): string {
  switch (status) {
    case 'running':
      return 'En cours';
    case 'completed':
      return 'Terminé';
    case 'stopped':
      return 'Interrompu';
    default:
      return 'Disponible';
  }
}

function describeScenarioEvent(event: ScenarioEvent | null | undefined): string {
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

function extractPlanMetadata(topology: SiteTopology | null): { planName: string | null; notes: string[] } {
  if (!topology) {
    return { planName: null, notes: [] };
  }
  let planName: string | null = null;
  const notes = new Set<string>();

  for (const device of topology.devices) {
    const props = device.props as Record<string, unknown> | undefined;
    const rawName = props?.planName;
    if (!planName && typeof rawName === 'string' && rawName.trim().length > 0) {
      planName = rawName.trim();
    }
    const rawNotes = props?.planNotes;
    if (typeof rawNotes === 'string' && rawNotes.trim().length > 0) {
      for (const line of rawNotes.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          notes.add(trimmed);
        }
      }
    }
  }

  return { planName, notes: Array.from(notes) };
}

function createEmptyScenarioDraft(): ScenarioDraft {
  return { name: '', description: '', events: [] };
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
  return {
    name: draft.name.trim(),
    description: draft.description?.trim() ? draft.description.trim() : undefined,
    events: draft.events.map(normalizeEventForPayload),
  };
}

function scenarioDefinitionToDraft(definition: ScenarioDefinition): ScenarioDraft {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    events: definition.events.map(ensureDraftEvent),
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
  const [scenarioError, setScenarioError] = useState<string | null>(null);
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

  const baseUrl = useMemo(() => import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4500', []);
  const sdk = useMemo(() => new SsiSdk(baseUrl), [baseUrl]);

  const refreshScenarios = useCallback(() => {
    sdk.listScenarios().then(setScenarios).catch(console.error);
  }, [sdk]);

  const refreshScenarioStatus = useCallback(() => {
    sdk.getActiveScenario().then(setScenarioStatus).catch(console.error);
  }, [sdk]);

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
    return () => {
      socket.disconnect();
    };
  }, [baseUrl, refreshScenarioStatus, refreshScenarios, sdk]);

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

  const handleScenarioNameChange = (name: string) => {
    setDraftScenario((prev) => ({ ...prev, name }));
  };

  const handleScenarioDescriptionChange = (description: string) => {
    setDraftScenario((prev) => ({ ...prev, description }));
  };

  const handleScenarioResetForm = () => {
    setDraftScenario(createEmptyScenarioDraft());
    setEditingScenarioId(null);
    setScenarioError(null);
  };

  const handleScenarioEdit = (scenario: ScenarioDefinition) => {
    setDraftScenario(scenarioDefinitionToDraft(scenario));
    setEditingScenarioId(scenario.id);
    setScenarioError(null);
  };

  const handleScenarioDelete = async (scenarioId: string) => {
    setScenarioDeleting(scenarioId);
    try {
      await sdk.deleteScenario(scenarioId);
      if (editingScenarioId === scenarioId) {
        handleScenarioResetForm();
      }
      refreshScenarios();
    } catch (error) {
      console.error(error);
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
    setScenarioSaving(true);
    try {
      const payload = draftToPayload(draftScenario);
      const saved = editingScenarioId
        ? await sdk.updateScenario(editingScenarioId, payload)
        : await sdk.createScenario(payload);
      setDraftScenario(scenarioDefinitionToDraft(saved));
      setEditingScenarioId(saved.id);
      refreshScenarios();
    } catch (error) {
      console.error(error);
      setScenarioError('Impossible de sauvegarder le scénario.');
    } finally {
      setScenarioSaving(false);
    }
  };

  const handleScenarioRun = async (scenarioId: string) => {
    try {
      const status = await sdk.runScenario(scenarioId);
      setScenarioStatus(status);
    } catch (error) {
      console.error(error);
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

  const remainingMs =
    snapshot?.cmsi?.deadline != null ? Math.max(0, snapshot.cmsi.deadline - now) : undefined;
  const dmList = Object.values(snapshot?.dmLatched ?? {});
  const daiList = Object.values(snapshot?.daiActivated ?? {});
  const manualActive = Boolean(snapshot?.manualEvacuation);
  const planMetadata = useMemo(() => extractPlanMetadata(topology), [topology]);
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
    if (!topology) {
      return [] as Array<{ value: string; label: string; kind?: string }>;
    }
    return [...topology.zones]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((zone) => ({
        value: zone.id.toUpperCase(),
        label: `${zone.label} (${zone.id.toUpperCase()})`,
        kind: zone.kind,
      }));
  }, [topology]);
  const defaultScenarioZoneId = scenarioZoneOptions[0]?.value ?? 'ZF1';
  const sortedDraftEvents = useMemo(
    () => [...draftScenario.events].sort((a, b) => a.offset - b.offset),
    [draftScenario.events],
  );
  const scenarioStateLabel = translateScenarioStatus(scenarioStatus.status);
  const nextScenarioEvent = describeScenarioEvent(scenarioStatus.nextEvent);
  const scenarioIsRunning = scenarioStatus.status === 'running';
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
                    <TimelineBadge label="Suspension" state="suspended" />
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
                  className="btn btn--ghost"
                  onClick={handleScenarioStop}
                  disabled={!scenarioIsRunning}
                >
                  Arrêter le scénario
                </button>
              </div>
            </div>
            <div className="scenario-layout">
              <aside className="scenario-sidebar">
                <div className="scenario-sidebar__header">
                  <h3 className="scenario-sidebar__title">Bibliothèque</h3>
                  <button type="button" className="btn btn--ghost" onClick={handleScenarioResetForm}>
                    Nouveau
                  </button>
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
                            onClick={() => handleScenarioRun(scenario.id)}
                            disabled={scenarioIsRunning && isActive}
                          >
                            Lancer
                          </button>
                          <button type="button" className="btn btn--outline" onClick={() => handleScenarioEdit(scenario)}>
                            Modifier
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
                {scenarioError && <p className="scenario-error">{scenarioError}</p>}
                <div className="scenario-form__actions">
                  <button type="submit" className="btn btn--primary" disabled={scenarioSaving} aria-busy={scenarioSaving}>
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
