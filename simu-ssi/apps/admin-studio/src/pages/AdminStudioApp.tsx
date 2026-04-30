import {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  MouseEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  SsiSdk,
  scenarioPayloadSchema,
  siteTopologySchema,
  type ScenarioDefinition,
  type ScenarioEvent,
  type ScenarioEventSequenceEntry,
  type ScenarioManualResetSelection,
  type SiteTopology,
  type SiteZone,
} from '@simu-ssi/sdk';

function getConfiguredApiToken(): string | undefined {
  const token = import.meta.env.VITE_SIMU_SSI_API_TOKEN;
  return typeof token === 'string' && token.trim().length > 0 ? token.trim() : undefined;
}

function createSocketOptions() {
  const token = getConfiguredApiToken();
  return token ? { auth: { token } } : undefined;
}


export type DeviceKind = 'DM' | 'DAI' | 'DAS' | 'UGA';

interface DevicePlacement {
  id: string;
  label: string;
  kind: DeviceKind;
  xPercent: number;
  yPercent: number;
  zoneId?: string;
}

const DEVICE_DEFINITIONS: Record<
  DeviceKind,
  { label: string; shortLabel: string; description: string; color: string }
> = {
  DM: {
    label: 'Déclencheur manuel',
    shortLabel: 'DM',
    description: 'Point de déclenchement manuel de l’alarme incendie.',
    color: '#ef4444',
  },
  DAI: {
    label: 'Détecteur automatique',
    shortLabel: 'DAI',
    description: 'Capteur détectant fumées ou chaleur anormales.',
    color: '#f97316',
  },
  DAS: {
    label: 'Dispositif actionné de sécurité',
    shortLabel: 'DAS',
    description: 'Commande les ouvrants, clapets et autres actionneurs.',
    color: '#0ea5e9',
  },
  UGA: {
    label: 'Unité de gestion d’alarme',
    shortLabel: 'UGA',
    description: 'Pilote la diffusion sonore et visuelle de l’alarme.',
    color: '#8b5cf6',
  },
};

const DEVICE_ORDER: DeviceKind[] = ['DM', 'DAI', 'DAS', 'UGA'];

const formatCoordinate = (value: number) => `${value.toFixed(1)}%`;

const createDeviceId = (kind: DeviceKind) => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${kind}-${crypto.randomUUID()}`;
  }
  return `${kind}-${Date.now()}-${Math.round(Math.random() * 1000)}`;
};

function getFallbackDeviceCoordinates(index: number, total: number) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(total)));
  const rows = Math.max(1, Math.ceil(total / columns));
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    xPercent: parseFloat((((column + 1) / (columns + 1)) * 100).toFixed(2)),
    yPercent: parseFloat((((row + 1) / (rows + 1)) * 100).toFixed(2)),
  };
}

function normalizePercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, value));
}

function extractDeviceCoordinates(device: SiteTopology['devices'][number]): {
  xPercent?: number;
  yPercent?: number;
} {
  const props = (device.props as Record<string, unknown> | undefined) ?? {};
  const coordinates = (props.coordinates as { xPercent?: unknown; yPercent?: unknown } | undefined) ?? {};

  const fromCoordinatesX = normalizePercent(coordinates.xPercent);
  const fromCoordinatesY = normalizePercent(coordinates.yPercent);

  if (typeof fromCoordinatesX === 'number' && typeof fromCoordinatesY === 'number') {
    return { xPercent: fromCoordinatesX, yPercent: fromCoordinatesY };
  }

  const fromLegacyX = normalizePercent(props.x);
  const fromLegacyY = normalizePercent(props.y);

  return {
    xPercent: typeof fromCoordinatesX === 'number' ? fromCoordinatesX : fromLegacyX,
    yPercent: typeof fromCoordinatesY === 'number' ? fromCoordinatesY : fromLegacyY,
  };
}

type ScenarioEventType = ScenarioEvent['type'];
type ScenarioEventDraft = ScenarioEvent & { id: string };

interface ScenarioDraft {
  id: string;
  name: string;
  description?: string;
  events: ScenarioEventDraft[];
  topology?: SiteTopology;
  manualResettable?: ScenarioManualResetSelection;
  evacuationAudio?: ScenarioDefinition['evacuationAudio'];
}

const SCENARIO_EVENT_OPTIONS: Array<{
  value: ScenarioEventType;
  label: string;
}> = [
  { value: 'DM_TRIGGER', label: 'DM trigger' },
  { value: 'DM_RESET', label: 'DM reset' },
  { value: 'DAI_TRIGGER', label: 'DAI trigger' },
  { value: 'DAI_RESET', label: 'DAI reset' },
  { value: 'MANUAL_EVAC_START', label: 'Manual evac start' },
  { value: 'MANUAL_EVAC_STOP', label: 'Manual evac stop' },
  { value: 'PROCESS_ACK', label: 'Process ack' },
  { value: 'PROCESS_CLEAR', label: 'Process clear' },
  { value: 'SYSTEM_RESET', label: 'System reset' },
];

function createScenarioEventId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.round(Math.random() * 1000)}`;
}

function normalizeScenarioOffset(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value * 10) / 10);
}

function isZoneScenarioEvent(
  event: ScenarioEventDraft,
): event is ScenarioEventDraft & { zoneId: string; sequence?: ScenarioEventSequenceEntry[] } {
  return (
    event.type === 'DM_TRIGGER' ||
    event.type === 'DM_RESET' ||
    event.type === 'DAI_TRIGGER' ||
    event.type === 'DAI_RESET'
  );
}

function sanitizeSequenceEntries(sequence?: ScenarioEventSequenceEntry[]): ScenarioEventSequenceEntry[] | undefined {
  if (!Array.isArray(sequence)) {
    return undefined;
  }
  const cleaned = sequence
    .map((entry) => ({
      deviceId: entry.deviceId.trim(),
      delay: normalizeScenarioOffset(entry.delay),
    }))
    .filter((entry) => entry.deviceId.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

function ensureScenarioDraftEvent(event: ScenarioEvent): ScenarioEventDraft {
  const id = event.id ?? createScenarioEventId();
  const base = {
    ...event,
    id,
    offset: normalizeScenarioOffset(event.offset),
  } as ScenarioEventDraft;
  if (isZoneScenarioEvent(base)) {
    const zoneEvent = { ...base } as ScenarioEventDraft & {
      zoneId: string;
      sequence?: ScenarioEventSequenceEntry[];
    };
    zoneEvent.sequence = sanitizeSequenceEntries(zoneEvent.sequence);
    return zoneEvent;
  }
  return base;
}

function createScenarioDraft(source: ScenarioDefinition): ScenarioDraft {
  return {
    id: source.id,
    name: source.name,
    description: source.description,
    events: source.events.map(ensureScenarioDraftEvent),
    topology: source.topology,
    manualResettable: source.manualResettable,
    evacuationAudio: source.evacuationAudio,
  };
}

function createScenarioEvent(type: ScenarioEventType, defaultZoneId?: string): ScenarioEventDraft {
  const base = {
    id: createScenarioEventId(),
    offset: 0,
    label: '',
  };
  switch (type) {
    case 'DM_TRIGGER':
    case 'DM_RESET':
    case 'DAI_TRIGGER':
    case 'DAI_RESET':
      return {
        ...base,
        type,
        zoneId: (defaultZoneId ?? '').toUpperCase(),
      } as ScenarioEventDraft;
    case 'MANUAL_EVAC_START':
    case 'MANUAL_EVAC_STOP':
      return { ...base, type, reason: '' } as ScenarioEventDraft;
    case 'PROCESS_ACK':
      return { ...base, type, ackedBy: 'admin' } as ScenarioEventDraft;
    case 'PROCESS_CLEAR':
    case 'SYSTEM_RESET':
      return { ...base, type } as ScenarioEventDraft;
    default:
      return { ...base, type: 'DM_TRIGGER', zoneId: (defaultZoneId ?? '').toUpperCase() } as ScenarioEventDraft;
  }
}

function adaptScenarioEventType(
  event: ScenarioEventDraft,
  nextType: ScenarioEventType,
  defaultZoneId?: string,
): ScenarioEventDraft {
  const base = {
    id: event.id,
    offset: normalizeScenarioOffset(event.offset),
    label: event.label,
  };
  const sequence = isZoneScenarioEvent(event) ? sanitizeSequenceEntries(event.sequence) : undefined;
  switch (nextType) {
    case 'DM_TRIGGER':
    case 'DM_RESET':
    case 'DAI_TRIGGER':
    case 'DAI_RESET':
      return {
        ...base,
        type: nextType,
        zoneId: (isZoneScenarioEvent(event) ? event.zoneId : defaultZoneId ?? '').toUpperCase(),
        sequence,
      } as ScenarioEventDraft;
    case 'MANUAL_EVAC_START':
    case 'MANUAL_EVAC_STOP':
      return {
        ...base,
        type: nextType,
        reason: event.type === 'MANUAL_EVAC_START' || event.type === 'MANUAL_EVAC_STOP' ? event.reason ?? '' : '',
      } as ScenarioEventDraft;
    case 'PROCESS_ACK':
      return {
        ...base,
        type: nextType,
        ackedBy: event.type === 'PROCESS_ACK' ? event.ackedBy ?? 'admin' : 'admin',
      } as ScenarioEventDraft;
    case 'PROCESS_CLEAR':
    case 'SYSTEM_RESET':
      return { ...base, type: nextType } as ScenarioEventDraft;
    default:
      return event;
  }
}

function normalizeScenarioEventForPayload(event: ScenarioEventDraft): ScenarioEvent {
  const label = event.label?.trim();
  const base = {
    id: event.id,
    offset: normalizeScenarioOffset(event.offset),
    ...(label ? { label } : {}),
  };

  switch (event.type) {
    case 'DM_TRIGGER':
    case 'DM_RESET':
    case 'DAI_TRIGGER':
    case 'DAI_RESET': {
      const sequence = sanitizeSequenceEntries(event.sequence);
      return {
        ...base,
        type: event.type,
        zoneId: event.zoneId.trim().toUpperCase(),
        ...(sequence ? { sequence } : {}),
      } as ScenarioEvent;
    }
    case 'MANUAL_EVAC_START':
    case 'MANUAL_EVAC_STOP':
      return {
        ...base,
        type: event.type,
        ...(event.reason?.trim() ? { reason: event.reason.trim() } : {}),
      } as ScenarioEvent;
    case 'PROCESS_ACK':
      return {
        ...base,
        type: event.type,
        ...(event.ackedBy?.trim() ? { ackedBy: event.ackedBy.trim() } : {}),
      } as ScenarioEvent;
    case 'PROCESS_CLEAR':
    case 'SYSTEM_RESET':
      return { ...base, type: event.type } as ScenarioEvent;
    default:
      return { ...base, type: 'PROCESS_CLEAR' } as ScenarioEvent;
  }
}

export function AdminStudioApp() {
  const baseUrl = useMemo(() => import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4500', []);
  const sdk = useMemo(() => new SsiSdk(baseUrl, { apiToken: getConfiguredApiToken() }), [baseUrl]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const topologyFileInputRef = useRef<HTMLInputElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pointerDownRef = useRef<{
    id: number;
    x: number;
    y: number;
    fromInteractiveTarget: boolean;
  } | null>(null);
  const skipClickRef = useRef(false);
  const isMountedRef = useRef(true);
  const copyTimeoutRef = useRef<number | null>(null);
  const publishTimeoutRef = useRef<number | null>(null);
  const scenarioTimeoutRef = useRef<number | null>(null);
  const selectedScenarioIdRef = useRef('');
  const loadedScenarioTopologyRef = useRef<string | null>(null);

  const [planImage, setPlanImage] = useState<string | null>(null);
  const [planName, setPlanName] = useState<string>('Aucun plan importé');
  const [planNotes, setPlanNotes] = useState('');
  const [devices, setDevices] = useState<DevicePlacement[]>([]);
  const [selectedKind, setSelectedKind] = useState<DeviceKind | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [zones, setZones] = useState<SiteZone[]>([]);
  const [isLoadingTopology, setIsLoadingTopology] = useState(false);
  const [topologyError, setTopologyError] = useState<string | null>(null);
  const [newZoneId, setNewZoneId] = useState('');
  const [newZoneLabel, setNewZoneLabel] = useState('');
  const [newZoneKind, setNewZoneKind] = useState('ZF');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [publishStatus, setPublishStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [publishError, setPublishError] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioDefinition[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState('');
  const [scenarioDraft, setScenarioDraft] = useState<ScenarioDraft | null>(null);
  const [newScenarioEventType, setNewScenarioEventType] = useState<ScenarioEventType>('DM_TRIGGER');
  const [isLoadingScenarios, setIsLoadingScenarios] = useState(false);
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const [scenarioSaveStatus, setScenarioSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [scenarioSaveError, setScenarioSaveError] = useState<string | null>(null);

  const hasWorkspaceContent = Boolean(planImage || devices.length > 0 || planNotes.trim().length > 0);

  const isDeviceKind = useCallback((value: string): value is DeviceKind => value in DEVICE_DEFINITIONS, []);

  useEffect(() => {
    selectedScenarioIdRef.current = selectedScenarioId;
  }, [selectedScenarioId]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      if (publishTimeoutRef.current) {
        window.clearTimeout(publishTimeoutRef.current);
      }
      if (scenarioTimeoutRef.current) {
        window.clearTimeout(scenarioTimeoutRef.current);
      }
    };
  }, []);

  const loadTopology = useCallback(async () => {
    if (!isMountedRef.current) {
      return;
    }
    setIsLoadingTopology(true);
    try {
      const topology = await sdk.getTopology();
      if (!isMountedRef.current) {
        return;
      }
      setZones(topology.zones);
      setTopologyError(null);
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }
      const message = error instanceof Error ? error.message : "Impossible de récupérer la topologie actuelle.";
      setTopologyError(message);
    } finally {
      if (isMountedRef.current) {
        setIsLoadingTopology(false);
      }
    }
  }, [sdk]);

  useEffect(() => {
    loadTopology();
  }, [loadTopology]);

  const loadScenarios = useCallback(async () => {
    if (!isMountedRef.current) {
      return;
    }
    setIsLoadingScenarios(true);
    try {
      const fetched = await sdk.listScenarios();
      if (!isMountedRef.current) {
        return;
      }
      setScenarios(fetched);
      setScenarioError(null);
      const previousSelectedId = selectedScenarioIdRef.current;
      const fallbackSelectedId =
        (previousSelectedId && fetched.some((scenario) => scenario.id === previousSelectedId)
          ? previousSelectedId
          : fetched[0]?.id) ?? '';
      setSelectedScenarioId(fallbackSelectedId);
      setScenarioDraft((previous) => {
        if (previous && fetched.some((scenario) => scenario.id === previous.id)) {
          return previous;
        }
        const initial = fetched.find((scenario) => scenario.id === fallbackSelectedId);
        return initial ? createScenarioDraft(initial) : null;
      });
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }
      const message =
        error instanceof Error ? error.message : 'Impossible de charger les scenarios existants.';
      setScenarioError(message);
    } finally {
      if (isMountedRef.current) {
        setIsLoadingScenarios(false);
      }
    }
  }, [sdk]);

  useEffect(() => {
    loadScenarios();
  }, [loadScenarios]);

  useEffect(() => {
    if (copyStatus === 'idle') {
      return;
    }
    if (copyTimeoutRef.current) {
      window.clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = window.setTimeout(() => {
      setCopyStatus('idle');
    }, 2500);
  }, [copyStatus]);

  useEffect(() => {
    if (publishStatus !== 'success') {
      return;
    }
    if (publishTimeoutRef.current) {
      window.clearTimeout(publishTimeoutRef.current);
    }
    publishTimeoutRef.current = window.setTimeout(() => {
      setPublishStatus('idle');
    }, 2500);
  }, [publishStatus]);

  useEffect(() => {
    if (scenarioSaveStatus !== 'success') {
      return;
    }
    if (scenarioTimeoutRef.current) {
      window.clearTimeout(scenarioTimeoutRef.current);
    }
    scenarioTimeoutRef.current = window.setTimeout(() => {
      setScenarioSaveStatus('idle');
      setScenarioSaveError(null);
    }, 2500);
  }, [scenarioSaveStatus]);

  const handlePlanFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('Le fichier doit être une image (PNG, JPG, SVG, …).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPlanImage(reader.result as string);
      setPlanName(file.name);
      setDevices([]);
      setPlanNotes('');
      setSelectedKind(null);
      setIsDragging(false);
    };
    reader.onerror = () => {
      alert("L'import du plan a échoué. Veuillez réessayer avec un autre fichier.");
      setIsDragging(false);
    };
    reader.readAsDataURL(file);
  }, []);

  const handlePlanUpload = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        handlePlanFile(file);
      }
      event.target.value = '';
    },
    [handlePlanFile],
  );

  const handlePlanDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) {
        handlePlanFile(file);
      }
    },
    [handlePlanFile],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const placeDeviceAtCoordinates = useCallback(
    (clientX: number, clientY: number) => {
      if (!planImage || !selectedKind) {
        return;
      }
      const imageEl = imageRef.current;
      if (!imageEl) {
        return;
      }
      const rect = imageEl.getBoundingClientRect();
      const x = (clientX - rect.left) / rect.width;
      const y = (clientY - rect.top) / rect.height;
      if (Number.isNaN(x) || Number.isNaN(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        return;
      }
      setDevices((previous) => {
        const nextIndex = previous.filter((device) => device.kind === selectedKind).length + 1;
        const newDevice: DevicePlacement = {
          id: createDeviceId(selectedKind),
          label: `${DEVICE_DEFINITIONS[selectedKind].shortLabel} ${nextIndex}`,
          kind: selectedKind,
          xPercent: parseFloat((x * 100).toFixed(2)),
          yPercent: parseFloat((y * 100).toFixed(2)),
        };
        return [...previous, newDevice];
      });
    },
    [planImage, selectedKind],
  );

  const handleStagePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    const interactiveTarget = (event.target as HTMLElement | null)?.closest(
      'button, a, input, textarea, select',
    );
    const fromInteractiveTarget = Boolean(
      interactiveTarget && event.currentTarget.contains(interactiveTarget) && interactiveTarget !== event.currentTarget,
    );
    pointerDownRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      fromInteractiveTarget,
    };
    if (!fromInteractiveTarget) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Ignore failures on browsers that do not support pointer capture.
      }
    }
  }, []);

  const handleStagePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const start = pointerDownRef.current;
      pointerDownRef.current = null;
      if (!start || start.id !== event.pointerId) {
        return;
      }
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (start.fromInteractiveTarget) {
        return;
      }
      if (event.pointerType === 'mouse' && event.button !== 0) {
        return;
      }
      const moveDistance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (moveDistance > 12) {
        return;
      }
      event.preventDefault();
      placeDeviceAtCoordinates(event.clientX, event.clientY);
      skipClickRef.current = true;
    },
    [placeDeviceAtCoordinates],
  );

  const handleStagePointerCancel = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointerDownRef.current = null;
    skipClickRef.current = false;
  }, []);

  const handleStagePointerLeave = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointerDownRef.current = null;
    skipClickRef.current = false;
  }, []);

  const handleStageClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (skipClickRef.current) {
        skipClickRef.current = false;
        event.preventDefault();
        return;
      }
      placeDeviceAtCoordinates(event.clientX, event.clientY);
    },
    [placeDeviceAtCoordinates],
  );

  const handleRemoveDevice = useCallback((id: string) => {
    setDevices((previous) => previous.filter((device) => device.id !== id));
  }, []);

  const handleRenameDevice = useCallback((id: string) => {
    setDevices((previous) => {
      const device = previous.find((item) => item.id === id);
      if (!device) {
        return previous;
      }
      const proposed = window.prompt('Nouveau libellé du dispositif', device.label);
      if (!proposed) {
        return previous;
      }
      const trimmed = proposed.trim();
      if (!trimmed) {
        return previous;
      }
      return previous.map((item) => (item.id === id ? { ...item, label: trimmed } : item));
    });
  }, []);

  const handleDeviceZoneChange = useCallback((deviceId: string, zoneId: string) => {
    setDevices((previous) =>
      previous.map((device) =>
        device.id === deviceId ? { ...device, zoneId: zoneId || undefined } : device,
      ),
    );
  }, []);

  const handleResetPlan = useCallback(() => {
    setPlanImage(null);
    setPlanName('Aucun plan importé');
    setPlanNotes('');
    setDevices([]);
    setSelectedKind(null);
    setIsDragging(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const applyImportedTopology = useCallback(
    (topology: SiteTopology) => {
      const plan = topology.plan;
      const hasPlanImage = Boolean(plan?.image);
      const importedPlanName = plan?.name?.trim();

      setPlanImage(hasPlanImage ? plan?.image ?? null : null);
      setPlanName(
        hasPlanImage
          ? importedPlanName && importedPlanName.length > 0
            ? importedPlanName
            : 'Plan importé'
          : 'Aucun plan importé',
      );
      setPlanNotes(plan?.notes ?? '');

      const sanitizedZones = topology.zones ?? [];
      setZones(sanitizedZones);

      const allowedZoneIds = new Set(sanitizedZones.map((zone) => zone.id));
      const warnings: string[] = [];
      const deviceCounts: Record<DeviceKind, number> = { DM: 0, DAI: 0, DAS: 0, UGA: 0 };

      const sourceDevices = topology.devices ?? [];
      const unplacedDevices = sourceDevices.filter((device) => {
        const coordinates = extractDeviceCoordinates(device);
        return typeof coordinates.xPercent !== 'number' || typeof coordinates.yPercent !== 'number';
      });
      let unplacedIndex = 0;

      const importedDevices: DevicePlacement[] = [];
      for (const device of sourceDevices) {
        if (!isDeviceKind(device.kind)) {
          warnings.push(`Dispositif «\u00a0${device.id}\u00a0» ignoré (type «\u00a0${device.kind}\u00a0» non géré).`);
          continue;
        }

        const coordinates = extractDeviceCoordinates(device);
        const xPercent = typeof coordinates.xPercent === 'number' ? coordinates.xPercent : undefined;
        const yPercent = typeof coordinates.yPercent === 'number' ? coordinates.yPercent : undefined;

        deviceCounts[device.kind] += 1;
        const fallbackLabel = `${DEVICE_DEFINITIONS[device.kind].shortLabel} ${deviceCounts[device.kind]}`;
        const label = device.label?.trim().length ? device.label.trim() : fallbackLabel;
        const zoneId = device.zoneId && allowedZoneIds.has(device.zoneId) ? device.zoneId : undefined;

        if (device.zoneId && !zoneId) {
          warnings.push(`Zone «\u00a0${device.zoneId}\u00a0» introuvable pour le dispositif «\u00a0${device.id}\u00a0».`);
        }
        if (xPercent === undefined || yPercent === undefined) {
          warnings.push(`Dispositif «\u00a0${device.id}\u00a0» placé provisoirement au centre du plan (coordonnées manquantes).`);
        }

        const fallbackCoordinates =
          xPercent === undefined || yPercent === undefined
            ? getFallbackDeviceCoordinates(unplacedIndex++, unplacedDevices.length)
            : null;

        importedDevices.push({
          id: device.id,
          kind: device.kind,
          label,
          xPercent: typeof xPercent === 'number' ? xPercent : fallbackCoordinates?.xPercent ?? 50,
          yPercent: typeof yPercent === 'number' ? yPercent : fallbackCoordinates?.yPercent ?? 50,
          zoneId,
        });
      }

      setDevices(importedDevices);
      setSelectedKind(null);
      setIsDragging(false);
      setCopyStatus('idle');
      setPublishStatus('idle');
      setPublishError(null);

      if (warnings.length > 0) {
        alert(`La topologie a été importée avec les avertissements suivants :\n- ${warnings.join('\n- ')}`);
      }
    },
    [isDeviceKind],
  );

  useEffect(() => {
    const scenario = selectedScenarioId
      ? scenarios.find((item) => item.id === selectedScenarioId)
      : null;
    if (!scenario) {
      loadedScenarioTopologyRef.current = null;
      return;
    }
    if (loadedScenarioTopologyRef.current === scenario.id) {
      return;
    }
    loadedScenarioTopologyRef.current = scenario.id;
    if (scenario.topology) {
      applyImportedTopology(scenario.topology);
    }
  }, [applyImportedTopology, scenarios, selectedScenarioId]);

  const handleTopologyImportClick = useCallback(() => {
    topologyFileInputRef.current?.click();
  }, []);

  const handleTopologyFileUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      try {
        const content = await file.text();
        const parsed = siteTopologySchema.parse(JSON.parse(content));
        applyImportedTopology(parsed);
      } catch (error) {
        console.error(error);
        const message =
          error instanceof Error
            ? error.message
            : 'Impossible de lire la topologie. Vérifiez que le fichier est un JSON valide.';
        alert(`Échec de l'import de la topologie : ${message}`);
      } finally {
        event.target.value = '';
      }
    },
    [applyImportedTopology],
  );

  const markerStyle = useCallback(
    (device: DevicePlacement): CSSProperties => ({
      left: `${device.xPercent}%`,
      top: `${device.yPercent}%`,
      backgroundColor: DEVICE_DEFINITIONS[device.kind].color,
    }),
    [],
  );

  const handleAddZone = useCallback(() => {
    const trimmedId = newZoneId.trim();
    const trimmedLabel = newZoneLabel.trim();
    const trimmedKind = newZoneKind.trim();
    if (!trimmedId || !trimmedLabel || !trimmedKind) {
      alert('Renseignez un identifiant, un libellé et un type de zone.');
      return;
    }
    if (zones.some((zone) => zone.id === trimmedId)) {
      alert(`La zone « ${trimmedId} » existe déjà.`);
      return;
    }
    setZones((previous) => [...previous, { id: trimmedId, label: trimmedLabel, kind: trimmedKind }]);
    setNewZoneId('');
    setNewZoneLabel('');
  }, [newZoneId, newZoneLabel, newZoneKind, zones]);

  const handleZoneFieldChange = useCallback(
    (zoneId: string, field: 'label' | 'kind', value: string) => {
      setZones((previous) =>
        previous.map((zone) => (zone.id === zoneId ? { ...zone, [field]: value } : zone)),
      );
    },
    [],
  );

  const handleRemoveZone = useCallback((zoneId: string) => {
    setZones((previous) => previous.filter((zone) => zone.id !== zoneId));
    setDevices((previous) =>
      previous.map((device) => (device.zoneId === zoneId ? { ...device, zoneId: undefined } : device)),
    );
  }, []);

  const handleRefreshTopology = useCallback(() => {
    loadTopology();
  }, [loadTopology]);

  const siteTopology = useMemo<SiteTopology>(() => {
    const sanitizedZones = zones
      .map((zone) => ({
        id: zone.id.trim(),
        label: zone.label.trim(),
        kind: zone.kind.trim(),
      }))
      .filter((zone): zone is SiteZone => zone.id.length > 0 && zone.label.length > 0 && zone.kind.length > 0);

    const allowedZoneIds = new Set(sanitizedZones.map((zone) => zone.id));

    const sanitizedDevices = devices.map((device) => {
      const zoneId = device.zoneId && allowedZoneIds.has(device.zoneId) ? device.zoneId : undefined;
      const props: Record<string, unknown> = {
        coordinates: {
          xPercent: device.xPercent,
          yPercent: device.yPercent,
        },
      };
      if (planImage) {
        props.planName = planName;
      }
      if (planNotes.trim()) {
        props.planNotes = planNotes.trim();
      }
      const cleanedProps = Object.fromEntries(
        Object.entries(props).filter(([, value]) => value !== undefined),
      );

      return {
        id: device.id,
        kind: device.kind,
        zoneId,
        label: device.label,
        props: Object.keys(cleanedProps).length > 0 ? cleanedProps : undefined,
      };
    });

    const plan = planImage
      ? {
          image: planImage,
          name: planName.trim().length > 0 ? planName.trim() : undefined,
          notes: planNotes.trim().length > 0 ? planNotes.trim() : undefined,
        }
      : undefined;

    return { plan, zones: sanitizedZones, devices: sanitizedDevices };
  }, [zones, devices, planImage, planName, planNotes]);

  const hasTopologyContent = siteTopology.zones.length > 0 || siteTopology.devices.length > 0;
  const siteTopologyJson = useMemo(() => JSON.stringify(siteTopology, null, 2), [siteTopology]);

  useEffect(() => {
    const hasEditableScenarioTopology =
      Boolean(planImage) ||
      planNotes.trim().length > 0 ||
      siteTopology.zones.length > 0 ||
      siteTopology.devices.length > 0;
    if (!hasEditableScenarioTopology) {
      return;
    }
    setScenarioDraft((previous) => {
      if (!previous) {
        return previous;
      }
      return { ...previous, topology: siteTopology };
    });
  }, [planImage, planNotes, siteTopology]);

  const handleDownloadTopology = useCallback(() => {
    if (!hasTopologyContent) {
      return;
    }

    const blob = new Blob([siteTopologyJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const normalizedName =
      planName.trim().length > 0 && planName !== 'Aucun plan importé' ? planName.trim() : 'topologie';
    const slug = normalizedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '');
    const fileName = `${slug || 'topologie'}-fpssi.json`;

    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }, [hasTopologyContent, planName, siteTopologyJson]);

  const handleCopyTopology = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(siteTopologyJson);
      setCopyStatus('success');
    } catch (error) {
      console.error(error);
      setCopyStatus('error');
    }
  }, [siteTopologyJson]);

  const handlePublishTopology = useCallback(async () => {
    if (!hasTopologyContent || publishStatus === 'saving') {
      return;
    }
    setPublishStatus('saving');
    setPublishError(null);
    try {
      await sdk.updateTopology(siteTopology);
      setPublishStatus('success');
      setPublishError(null);
      void loadTopology();
    } catch (error) {
      console.error(error);
      const rawMessage = error instanceof Error ? error.message : 'La publication du plan a échoué.';
      const message = rawMessage.startsWith('UNKNOWN_ZONE:')
        ? `Un dispositif est associé à une zone inexistante (${rawMessage.split(':')[1] ?? 'zone inconnue'}).`
        : rawMessage;
      setPublishStatus('error');
      setPublishError(message);
    }
  }, [hasTopologyContent, loadTopology, publishStatus, sdk, siteTopology]);

  const scenarioZoneOptions = useMemo(() => {
    const sourceZones =
      scenarioDraft?.topology?.zones && scenarioDraft.topology.zones.length > 0
        ? scenarioDraft.topology.zones
        : zones;
    return sourceZones
      .map((zone) => ({
        id: zone.id,
        label: zone.label,
        kind: zone.kind,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  }, [scenarioDraft, zones]);

  const defaultScenarioZoneId = scenarioZoneOptions[0]?.id ?? '';

  const loadScenarioIntoDraft = useCallback(
    (scenarioId: string) => {
      const source = scenarios.find((scenario) => scenario.id === scenarioId);
      if (!source) {
        return;
      }
      setScenarioDraft(createScenarioDraft(source));
      setScenarioSaveStatus('idle');
      setScenarioSaveError(null);
    },
    [scenarios],
  );

  const handleScenarioSelectionChange = useCallback((scenarioId: string) => {
    setSelectedScenarioId(scenarioId);
  }, []);

  const handleLoadSelectedScenario = useCallback(() => {
    if (!selectedScenarioId) {
      return;
    }
    loadScenarioIntoDraft(selectedScenarioId);
  }, [loadScenarioIntoDraft, selectedScenarioId]);

  const handleRefreshScenarios = useCallback(() => {
    void loadScenarios();
  }, [loadScenarios]);

  const updateScenarioDraftEvent = useCallback(
    (eventId: string, updater: (event: ScenarioEventDraft) => ScenarioEventDraft) => {
      setScenarioDraft((previous) => {
        if (!previous) {
          return previous;
        }
        return {
          ...previous,
          events: previous.events.map((event) => (event.id === eventId ? updater(event) : event)),
        };
      });
      setScenarioSaveStatus('idle');
      setScenarioSaveError(null);
    },
    [],
  );

  const handleScenarioNameChange = useCallback((name: string) => {
    setScenarioDraft((previous) => (previous ? { ...previous, name } : previous));
    setScenarioSaveStatus('idle');
    setScenarioSaveError(null);
  }, []);

  const handleScenarioDescriptionChange = useCallback((description: string) => {
    setScenarioDraft((previous) => (previous ? { ...previous, description } : previous));
    setScenarioSaveStatus('idle');
    setScenarioSaveError(null);
  }, []);

  const handleScenarioAddEvent = useCallback(() => {
    setScenarioDraft((previous) => {
      if (!previous) {
        return previous;
      }
      return {
        ...previous,
        events: [...previous.events, createScenarioEvent(newScenarioEventType, defaultScenarioZoneId)],
      };
    });
    setScenarioSaveStatus('idle');
    setScenarioSaveError(null);
  }, [defaultScenarioZoneId, newScenarioEventType]);

  const handleScenarioRemoveEvent = useCallback((eventId: string) => {
    setScenarioDraft((previous) => {
      if (!previous) {
        return previous;
      }
      return {
        ...previous,
        events: previous.events.filter((event) => event.id !== eventId),
      };
    });
    setScenarioSaveStatus('idle');
    setScenarioSaveError(null);
  }, []);

  const handleScenarioDuplicateEvent = useCallback((eventId: string) => {
    setScenarioDraft((previous) => {
      if (!previous) {
        return previous;
      }
      const sourceIndex = previous.events.findIndex((event) => event.id === eventId);
      if (sourceIndex < 0) {
        return previous;
      }
      const source = previous.events[sourceIndex];
      const duplicate = ensureScenarioDraftEvent({
        ...source,
        id: createScenarioEventId(),
        offset: normalizeScenarioOffset(source.offset + 5),
      });
      const nextEvents = [...previous.events];
      nextEvents.splice(sourceIndex + 1, 0, duplicate);
      return { ...previous, events: nextEvents };
    });
    setScenarioSaveStatus('idle');
    setScenarioSaveError(null);
  }, []);

  const handleScenarioShiftEventOffset = useCallback((eventId: string, delta: number) => {
    updateScenarioDraftEvent(eventId, (event) => ({
      ...event,
      offset: normalizeScenarioOffset(event.offset + delta),
    }));
  }, [updateScenarioDraftEvent]);

  const handleScenarioShiftAllOffsets = useCallback((delta: number) => {
    setScenarioDraft((previous) => {
      if (!previous) {
        return previous;
      }
      return {
        ...previous,
        events: previous.events.map((event) => ({
          ...event,
          offset: normalizeScenarioOffset(event.offset + delta),
        })),
      };
    });
    setScenarioSaveStatus('idle');
    setScenarioSaveError(null);
  }, []);

  const handleScenarioNormalizeOffsets = useCallback(() => {
    setScenarioDraft((previous) => {
      if (!previous) {
        return previous;
      }
      const ordered = [...previous.events].sort((a, b) => a.offset - b.offset);
      const offsetById = new Map<string, number>();
      ordered.forEach((event, index) => {
        offsetById.set(event.id, normalizeScenarioOffset(index * 10));
      });
      return {
        ...previous,
        events: previous.events.map((event) => ({
          ...event,
          offset: offsetById.get(event.id) ?? normalizeScenarioOffset(event.offset),
        })),
      };
    });
    setScenarioSaveStatus('idle');
    setScenarioSaveError(null);
  }, []);

  const handleScenarioEventTypeChange = useCallback((eventId: string, type: ScenarioEventType) => {
    updateScenarioDraftEvent(eventId, (event) => adaptScenarioEventType(event, type, defaultScenarioZoneId));
  }, [defaultScenarioZoneId, updateScenarioDraftEvent]);

  const handleScenarioEventOffsetChange = useCallback((eventId: string, value: number) => {
    updateScenarioDraftEvent(eventId, (event) => ({
      ...event,
      offset: normalizeScenarioOffset(value),
    }));
  }, [updateScenarioDraftEvent]);

  const handleScenarioEventZoneChange = useCallback((eventId: string, zoneId: string) => {
    updateScenarioDraftEvent(eventId, (event) => {
      if (!isZoneScenarioEvent(event)) {
        return event;
      }
      return {
        ...event,
        zoneId: zoneId.toUpperCase(),
      };
    });
  }, [updateScenarioDraftEvent]);

  const handleScenarioEventReasonChange = useCallback((eventId: string, reason: string) => {
    updateScenarioDraftEvent(eventId, (event) => {
      if (event.type !== 'MANUAL_EVAC_START' && event.type !== 'MANUAL_EVAC_STOP') {
        return event;
      }
      return { ...event, reason };
    });
  }, [updateScenarioDraftEvent]);

  const handleScenarioEventAckedByChange = useCallback((eventId: string, ackedBy: string) => {
    updateScenarioDraftEvent(eventId, (event) => {
      if (event.type !== 'PROCESS_ACK') {
        return event;
      }
      return { ...event, ackedBy };
    });
  }, [updateScenarioDraftEvent]);

  const handleScenarioEventLabelChange = useCallback((eventId: string, label: string) => {
    updateScenarioDraftEvent(eventId, (event) => ({ ...event, label }));
  }, [updateScenarioDraftEvent]);

  const handleScenarioSave = useCallback(async () => {
    if (!scenarioDraft || scenarioSaveStatus === 'saving') {
      return;
    }
    if (!scenarioDraft.name.trim()) {
      setScenarioSaveStatus('error');
      setScenarioSaveError('Le nom du scenario est obligatoire.');
      return;
    }
    if (scenarioDraft.events.length === 0) {
      setScenarioSaveStatus('error');
      setScenarioSaveError('Ajoutez au moins un evenement.');
      return;
    }
    setScenarioSaveStatus('saving');
    setScenarioSaveError(null);
    try {
      const payload = scenarioPayloadSchema.parse({
        name: scenarioDraft.name.trim(),
        description: scenarioDraft.description?.trim() ? scenarioDraft.description.trim() : undefined,
        events: scenarioDraft.events.map((event) => normalizeScenarioEventForPayload(event)),
        topology: scenarioDraft.topology,
        manualResettable: scenarioDraft.manualResettable,
        evacuationAudio: scenarioDraft.evacuationAudio,
      });
      const updated = await sdk.updateScenario(scenarioDraft.id, payload);
      if (!isMountedRef.current) {
        return;
      }
      setScenarios((previous) =>
        previous
          .map((scenario) => (scenario.id === updated.id ? updated : scenario))
          .sort((a, b) => a.name.localeCompare(b.name, 'fr')),
      );
      setSelectedScenarioId(updated.id);
      setScenarioDraft(createScenarioDraft(updated));
      setScenarioSaveStatus('success');
      setScenarioSaveError(null);
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }
      const message =
        error instanceof Error
          ? error.message
          : 'Echec de la mise a jour du scenario.';
      setScenarioSaveStatus('error');
      setScenarioSaveError(message);
    }
  }, [scenarioDraft, scenarioSaveStatus, sdk]);

  const scenarioSaveFeedbackMessage =
    scenarioSaveStatus === 'success'
      ? 'Scenario mis a jour.'
      : scenarioSaveStatus === 'error'
        ? scenarioSaveError ?? 'Echec de la mise a jour du scenario.'
        : scenarioSaveStatus === 'saving'
          ? 'Enregistrement en cours...'
          : scenarioDraft
            ? 'Modifiez les evenements puis enregistrez.'
            : 'Chargez un scenario pour demarrer.';

  const isAddZoneDisabled = !newZoneId.trim() || !newZoneLabel.trim() || !newZoneKind.trim();
  const publishFeedbackMessage = publishStatus === 'success'
    ? 'Plan synchronisé avec les postes formateur et apprenant.'
    : publishStatus === 'error'
      ? publishError ?? 'La publication du plan a échoué.'
      : publishStatus === 'saving'
        ? 'Publication en cours…'
        : hasTopologyContent
          ? 'Publiez pour rendre ce plan disponible sur les autres postes.'
          : 'Ajoutez un plan et des dispositifs pour activer la publication.';

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1 className="app-title">Studio Administrateur</h1>
          <p className="app-subtitle">
            Importez vos plans, positionnez les dispositifs FPSSI et préparez vos scénarios pédagogiques.
          </p>
        </div>
        <div className="connection-hint">
          <span className="connection-label">Serveur connecté</span>
          <code className="connection-url">{baseUrl}</code>
        </div>
      </header>
      <div className="app-layout">
        <section className="panel plan-panel">
          <div className="panel-header">
            <h2>Plan interactif</h2>
            <span className="plan-name" title={planName}>
              {planName}
            </span>
          </div>
          <div
            className={`plan-stage${planImage ? '' : ' plan-stage--empty'}${isDragging ? ' plan-stage--dragging' : ''}`}
            onPointerDown={handleStagePointerDown}
            onPointerUp={handleStagePointerUp}
            onPointerCancel={handleStagePointerCancel}
            onPointerLeave={handleStagePointerLeave}
            onClick={handleStageClick}
            onDrop={handlePlanDrop}
            onDragEnter={handleDragOver}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            {planImage ? (
              <div className="plan-image-wrapper">
                <img ref={imageRef} src={planImage} alt={`Plan ${planName}`} />
                <div className="plan-overlay">
                  {devices.map((device) => (
                    <button
                      key={device.id}
                      type="button"
                      className="device-marker"
                      style={markerStyle(device)}
                      title={`${device.label} — ${formatCoordinate(device.xPercent)}, ${formatCoordinate(device.yPercent)}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedKind(device.kind);
                      }}
                    >
                      {device.kind}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="plan-placeholder">
                <p>Glissez-déposez un plan ou utilisez le bouton ci-dessous.</p>
                <button type="button" className="button button-primary" onClick={handleImportClick}>
                  Importer un plan
                </button>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="visually-hidden"
              onChange={handlePlanUpload}
            />
          </div>
          <p className="stage-hint">
            {planImage
              ? selectedKind
                ? `Touchez ou cliquez sur le plan pour placer un ${DEVICE_DEFINITIONS[selectedKind].label.toLowerCase()}.`
                : 'Sélectionnez un type de dispositif dans la palette pour commencer le placement.'
              : "Importez un plan pour activer l'espace de travail."}
          </p>
        </section>
        <aside className="control-sidebar">
          <section className="panel">
            <h2>Importation de plan</h2>
            <p>
              Chargez un plan d'évacuation (PNG, JPG ou SVG). L'import d'un nouveau plan réinitialise la liste des
              dispositifs.
            </p>
            <div className="button-row">
              <button type="button" className="button button-primary" onClick={handleImportClick}>
                Choisir un plan
              </button>
              <button type="button" className="button" onClick={handleResetPlan} disabled={!hasWorkspaceContent}>
                Réinitialiser
              </button>
            </div>
            {planImage && (
              <label className="field">
                <span className="field-label">Annotations sur le plan</span>
                <textarea
                  value={planNotes}
                  onChange={(event) => setPlanNotes(event.target.value)}
                  placeholder="Ajoutez des consignes, zones sensibles, numéros d'appel…"
                  rows={4}
                />
              </label>
            )}
          </section>
          <section className="panel">
            <h2>Palette de dispositifs</h2>
            <div className="device-palette">
              {DEVICE_ORDER.map((kind) => {
                const definition = DEVICE_DEFINITIONS[kind];
                const active = selectedKind === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    className={`device-palette__item${active ? ' device-palette__item--active' : ''}`}
                    onClick={() => setSelectedKind(active ? null : kind)}
                    disabled={!planImage}
                  >
                    <span
                      className="device-palette__badge"
                      aria-hidden="true"
                      style={{ backgroundColor: definition.color }}
                    >
                      {kind}
                    </span>
                    <span className="device-palette__labels">
                      <strong>{definition.label}</strong>
                      <small>{definition.description}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="panel">
            <h2>Dispositifs placés</h2>
            {devices.length === 0 ? (
              <p className="empty-state">Aucun dispositif pour le moment.</p>
            ) : (
              <ul className="device-list">
                {devices.map((device) => (
                  <li key={device.id} className="device-list__item">
                    <div className="device-list__info">
                      <div className="device-list__meta">
                        <span
                          className="device-list__badge"
                          style={{ backgroundColor: DEVICE_DEFINITIONS[device.kind].color }}
                        >
                          {device.kind}
                        </span>
                        <div>
                          <strong>{device.label}</strong>
                          <span className="device-list__coordinates">
                            {formatCoordinate(device.xPercent)} · {formatCoordinate(device.yPercent)}
                          </span>
                        </div>
                      </div>
                      <label className="device-zone">
                        <span>Zone FPSSI</span>
                        <select
                          value={device.zoneId ?? ''}
                          onChange={(event) => handleDeviceZoneChange(device.id, event.target.value)}
                        >
                          <option value="">Sans zone</option>
                          {zones.map((zone) => (
                            <option key={zone.id} value={zone.id}>
                              {zone.label} ({zone.kind})
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="device-list__actions">
                      <button type="button" className="button button-ghost" onClick={() => handleRenameDevice(device.id)}>
                        Renommer
                      </button>
                      <button type="button" className="button button-ghost" onClick={() => handleRemoveDevice(device.id)}>
                        Supprimer
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
            <div className="panel-header">
              <h2>Scenarios existants</h2>
              <div className="topology-status">
                {isLoadingScenarios ? <span>Chargement...</span> : null}
                <button type="button" className="button button-ghost" onClick={handleRefreshScenarios}>
                  Rafraichir
                </button>
              </div>
            </div>
            <p>Chargez un scenario du serveur, modifiez les evenements puis enregistrez.</p>
            {scenarioError ? <p className="error-message">{scenarioError}</p> : null}
            {scenarios.length === 0 ? (
              <p className="empty-state">Aucun scenario disponible.</p>
            ) : (
              <div className="scenario-admin">
                <label className="field">
                  <span className="field-label">Scenario cible</span>
                  <div className="scenario-admin__selector">
                    <select
                      value={selectedScenarioId}
                      onChange={(event) => handleScenarioSelectionChange(event.target.value)}
                    >
                      {scenarios.map((scenario) => (
                        <option key={scenario.id} value={scenario.id}>
                          {scenario.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="button"
                      onClick={handleLoadSelectedScenario}
                      disabled={!selectedScenarioId}
                    >
                      Charger
                    </button>
                  </div>
                </label>
                {scenarioDraft ? (
                  <>
                    <label className="field">
                      <span className="field-label">Nom du scenario</span>
                      <input
                        type="text"
                        value={scenarioDraft.name}
                        onChange={(event) => handleScenarioNameChange(event.target.value)}
                        placeholder="Scenario detection"
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Description</span>
                      <textarea
                        className="scenario-admin__description"
                        value={scenarioDraft.description ?? ''}
                        onChange={(event) => handleScenarioDescriptionChange(event.target.value)}
                        rows={3}
                        placeholder="Contexte pedagogique et objectifs"
                      />
                    </label>
                    <div className="button-row">
                      <button
                        type="button"
                        className="button"
                        onClick={() => handleScenarioShiftAllOffsets(-5)}
                        disabled={scenarioDraft.events.length === 0}
                      >
                        Offsets -5s
                      </button>
                      <button
                        type="button"
                        className="button"
                        onClick={() => handleScenarioShiftAllOffsets(5)}
                        disabled={scenarioDraft.events.length === 0}
                      >
                        Offsets +5s
                      </button>
                      <button
                        type="button"
                        className="button"
                        onClick={handleScenarioNormalizeOffsets}
                        disabled={scenarioDraft.events.length === 0}
                      >
                        Auto offset 10s
                      </button>
                    </div>
                    {scenarioDraft.events.length === 0 ? (
                      <p className="empty-state">Ce scenario ne contient aucun evenement.</p>
                    ) : (
                      <ul className="scenario-admin-events">
                        {scenarioDraft.events.map((eventDraft, index) => (
                          <li key={eventDraft.id} className="scenario-admin-event">
                            <div className="scenario-admin-event__header">
                              <strong>Etape {index + 1}</strong>
                              <div className="scenario-admin-event__actions">
                                <button
                                  type="button"
                                  className="button button-ghost"
                                  onClick={() => handleScenarioShiftEventOffset(eventDraft.id, -5)}
                                >
                                  -5s
                                </button>
                                <button
                                  type="button"
                                  className="button button-ghost"
                                  onClick={() => handleScenarioShiftEventOffset(eventDraft.id, 5)}
                                >
                                  +5s
                                </button>
                                <button
                                  type="button"
                                  className="button button-ghost"
                                  onClick={() => handleScenarioDuplicateEvent(eventDraft.id)}
                                >
                                  Dupliquer
                                </button>
                                <button
                                  type="button"
                                  className="button button-ghost"
                                  onClick={() => handleScenarioRemoveEvent(eventDraft.id)}
                                >
                                  Supprimer
                                </button>
                              </div>
                            </div>
                            <div className="scenario-admin-event__grid">
                              <label className="field">
                                <span className="field-label">Type</span>
                                <select
                                  value={eventDraft.type}
                                  onChange={(event) =>
                                    handleScenarioEventTypeChange(eventDraft.id, event.target.value as ScenarioEventType)
                                  }
                                >
                                  {SCENARIO_EVENT_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="field">
                                <span className="field-label">Offset (s)</span>
                                <input
                                  type="number"
                                  min={0}
                                  step={0.1}
                                  value={eventDraft.offset}
                                  onChange={(event) =>
                                    handleScenarioEventOffsetChange(
                                      eventDraft.id,
                                      Number.parseFloat(event.target.value || '0'),
                                    )
                                  }
                                />
                              </label>
                              {isZoneScenarioEvent(eventDraft) && (
                                <label className="field">
                                  <span className="field-label">Zone</span>
                                  <select
                                    value={eventDraft.zoneId}
                                    onChange={(event) => handleScenarioEventZoneChange(eventDraft.id, event.target.value)}
                                  >
                                    <option value="">Selectionner une zone</option>
                                    {scenarioZoneOptions.map((zone) => (
                                      <option key={zone.id} value={zone.id}>
                                        {zone.label} ({zone.kind})
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              )}
                              {(eventDraft.type === 'MANUAL_EVAC_START' || eventDraft.type === 'MANUAL_EVAC_STOP') && (
                                <label className="field">
                                  <span className="field-label">Reason</span>
                                  <input
                                    type="text"
                                    value={eventDraft.reason ?? ''}
                                    onChange={(event) => handleScenarioEventReasonChange(eventDraft.id, event.target.value)}
                                    placeholder="Cause manuelle"
                                  />
                                </label>
                              )}
                              {eventDraft.type === 'PROCESS_ACK' && (
                                <label className="field">
                                  <span className="field-label">Acked by</span>
                                  <input
                                    type="text"
                                    value={eventDraft.ackedBy ?? ''}
                                    onChange={(event) => handleScenarioEventAckedByChange(eventDraft.id, event.target.value)}
                                    placeholder="admin"
                                  />
                                </label>
                              )}
                            </div>
                            <label className="field">
                              <span className="field-label">Label (optionnel)</span>
                              <input
                                type="text"
                                value={eventDraft.label ?? ''}
                                onChange={(event) => handleScenarioEventLabelChange(eventDraft.id, event.target.value)}
                                placeholder="Etape incendie"
                              />
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="scenario-admin__add-event">
                      <label className="field">
                        <span className="field-label">Nouveau type d'evenement</span>
                        <select
                          value={newScenarioEventType}
                          onChange={(event) => setNewScenarioEventType(event.target.value as ScenarioEventType)}
                        >
                          {SCENARIO_EVENT_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button type="button" className="button" onClick={handleScenarioAddEvent}>
                        Ajouter un evenement
                      </button>
                    </div>
                    <div className="button-row">
                      <button
                        type="button"
                        className="button button-primary"
                        onClick={handleScenarioSave}
                        disabled={scenarioSaveStatus === 'saving'}
                      >
                        {scenarioSaveStatus === 'saving' ? 'Enregistrement...' : 'Enregistrer le scenario'}
                      </button>
                      <button
                        type="button"
                        className="button"
                        onClick={handleLoadSelectedScenario}
                        disabled={!selectedScenarioId}
                      >
                        Annuler les modifications
                      </button>
                    </div>
                    <span className={`topology-publish-feedback topology-publish-feedback--${scenarioSaveStatus}`}>
                      {scenarioSaveFeedbackMessage}
                    </span>
                  </>
                ) : null}
              </div>
            )}
          </section>
          <section className="panel">
            <div className="panel-header">
              <h2>Zones FPSSI</h2>
              <div className="topology-status">
                {isLoadingTopology ? <span>Chargement…</span> : null}
                {topologyError ? (
                  <button type="button" className="button button-ghost" onClick={handleRefreshTopology}>
                    Réessayer
                  </button>
                ) : null}
              </div>
            </div>
            <p>
              Déclarez les zones FPSSI pour structurer la topologie. Les zones importées depuis le serveur peuvent être
              ajustées (libellé et type) avant d&apos;associer les dispositifs placés.
            </p>
            {topologyError ? <p className="error-message">{topologyError}</p> : null}
            <div className="zone-form">
              <div className="zone-form__grid">
                <label className="field">
                  <span className="field-label">Identifiant</span>
                  <input
                    type="text"
                    value={newZoneId}
                    onChange={(event) => setNewZoneId(event.target.value)}
                    placeholder="ZF1, ZF-RDC…"
                  />
                </label>
                <label className="field">
                  <span className="field-label">Libellé</span>
                  <input
                    type="text"
                    value={newZoneLabel}
                    onChange={(event) => setNewZoneLabel(event.target.value)}
                    placeholder="Zone feu RDC"
                  />
                </label>
                <label className="field">
                  <span className="field-label">Type</span>
                  <input
                    type="text"
                    value={newZoneKind}
                    onChange={(event) => setNewZoneKind(event.target.value)}
                    placeholder="ZF, ZS, TA…"
                  />
                </label>
              </div>
              <div className="button-row">
                <button type="button" className="button button-primary" onClick={handleAddZone} disabled={isAddZoneDisabled}>
                  Ajouter la zone
                </button>
              </div>
            </div>
            {zones.length === 0 ? (
              <p className="empty-state">Aucune zone n&apos;est définie pour le moment.</p>
            ) : (
              <ul className="zone-list">
                {zones.map((zone) => (
                  <li key={zone.id} className="zone-list__item">
                    <div className="zone-list__header">
                      <span className="zone-id">{zone.id}</span>
                      <div className="zone-list__actions">
                        <button type="button" className="button button-ghost" onClick={() => handleRemoveZone(zone.id)}>
                          Supprimer
                        </button>
                      </div>
                    </div>
                    <div className="zone-list__fields">
                      <label className="field">
                        <span className="field-label">Libellé</span>
                        <input
                          type="text"
                          value={zone.label}
                          onChange={(event) => handleZoneFieldChange(zone.id, 'label', event.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">Type</span>
                        <input
                          type="text"
                          value={zone.kind}
                          onChange={(event) => handleZoneFieldChange(zone.id, 'kind', event.target.value)}
                        />
                      </label>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
            <h2>Import / export topologie FPSSI</h2>
            <p>
              Importez un fichier JSON existant ou exportez la configuration actuelle. Le JSON respecte le schéma
              <code>SiteTopology</code> du SDK et peut être envoyé directement au serveur du simulateur.
            </p>
            <div className="topology-preview">
              <textarea
                className="topology-preview__textarea"
                value={siteTopologyJson}
                readOnly
                rows={10}
                spellCheck={false}
              />
              <div className="topology-preview__actions">
                <div className="topology-preview__buttons">
                  <button type="button" className="button" onClick={handleTopologyImportClick}>
                    Importer un fichier
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={handleDownloadTopology}
                    disabled={!hasTopologyContent}
                  >
                    Télécharger le JSON
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={handleCopyTopology}
                    disabled={!hasTopologyContent}
                  >
                    Copier la topologie
                  </button>
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={handlePublishTopology}
                    disabled={!hasTopologyContent || publishStatus === 'saving'}
                  >
                    {publishStatus === 'saving' ? 'Publication…' : 'Mettre à disposition'}
                  </button>
                </div>
                <input
                  ref={topologyFileInputRef}
                  type="file"
                  accept="application/json"
                  className="visually-hidden"
                  onChange={handleTopologyFileUpload}
                />
                <span className={`topology-copy-feedback topology-copy-feedback--${copyStatus}`}>
                  {copyStatus === 'success'
                    ? 'Topologie copiée dans le presse-papiers.'
                    : copyStatus === 'error'
                      ? 'La copie a échoué. Copiez manuellement le JSON.'
                      : hasTopologyContent
                        ? 'Ajustez zones et dispositifs avant export.'
                        : 'Ajoutez un plan et des dispositifs pour générer la topologie.'}
                </span>
                <span className={`topology-publish-feedback topology-publish-feedback--${publishStatus}`}>
                  {publishFeedbackMessage}
                </span>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
