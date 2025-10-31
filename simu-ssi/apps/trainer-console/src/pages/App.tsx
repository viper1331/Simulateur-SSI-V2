import { useCallback, useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { ManualEvacuationPanel, StatusTile, TimelineBadge } from '@simu-ssi/shared-ui';
import {
  SsiSdk,
  type ScenarioDefinition,
  type ScenarioEvent,
  type ScenarioPayload,
  type ScenarioRunnerSnapshot,
  type SiteConfig,
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

function createEmptyScenarioDraft(): ScenarioDraft {
  return { name: '', description: '', events: [] };
}

function ensureDraftEvent(event: ScenarioEvent): ScenarioEventDraft {
  const id = event.id ?? crypto.randomUUID();
  return { ...event, id } as ScenarioEventDraft;
}

function createDraftEvent(type: ScenarioEvent['type']): ScenarioEventDraft {
  const id = crypto.randomUUID();
  const base = { id, offset: 0, label: '' as string | undefined };
  switch (type) {
    case 'DM_TRIGGER':
    case 'DM_RESET':
    case 'DAI_TRIGGER':
    case 'DAI_RESET':
      return { ...base, type, zoneId: 'ZF1' } as ScenarioEventDraft;
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

function adaptEventForType(event: ScenarioEventDraft, type: ScenarioEvent['type']): ScenarioEventDraft {
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
      return { ...base, type, zoneId: zone ?? 'ZF1' } as ScenarioEventDraft;
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

export function App() {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [snapshot, setSnapshot] = useState<DomainSnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [events, setEvents] = useState<string[]>([]);
  const [ackPending, setAckPending] = useState(false);
  const [clearPending, setClearPending] = useState(false);
  const [simulateDmPending, setSimulateDmPending] = useState(false);
  const [simulateDaiPending, setSimulateDaiPending] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [resettingZone, setResettingZone] = useState<string | null>(null);
  const [resettingDaiZone, setResettingDaiZone] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioDefinition[]>([]);
  const [scenarioStatus, setScenarioStatus] = useState<ScenarioRunnerSnapshot>({ status: 'idle' });
  const [draftScenario, setDraftScenario] = useState<ScenarioDraft>(() => createEmptyScenarioDraft());
  const [editingScenarioId, setEditingScenarioId] = useState<string | null>(null);
  const [scenarioSaving, setScenarioSaving] = useState(false);
  const [scenarioDeleting, setScenarioDeleting] = useState<string | null>(null);
  const [scenarioError, setScenarioError] = useState<string | null>(null);

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
    refreshScenarios();
    refreshScenarioStatus();
    const socket = io(baseUrl);
    socket.on('state.update', (state: DomainSnapshot) => setSnapshot(state));
    socket.on('events.append', (event: { ts: number; message: string; source: string }) => {
      setEvents((prev) => [`[${new Date(event.ts).toLocaleTimeString()}] ${event.source}: ${event.message}`, ...prev].slice(0, 12));
    });
    socket.on('scenario.update', (status: ScenarioRunnerSnapshot) => setScenarioStatus(status));
    return () => {
      socket.disconnect();
    };
  }, [baseUrl, refreshScenarioStatus, refreshScenarios, sdk]);

  useEffect(() => {
    if (!snapshot?.cmsi?.deadline) {
      return;
    }

    const tick = () => setNow(Date.now());
    tick();

    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [snapshot?.cmsi?.deadline]);

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

  const updateDraftEvent = (eventId: string, updater: (event: ScenarioEventDraft) => ScenarioEventDraft) => {
    setDraftScenario((prev) => ({
      ...prev,
      events: prev.events.map((event) => (event.id === eventId ? updater(event) : event)),
    }));
  };

  const handleScenarioAddEvent = () => {
    setDraftScenario((prev) => ({
      ...prev,
      events: [...prev.events, createDraftEvent('DM_TRIGGER')],
    }));
  };

  const handleScenarioRemoveEvent = (eventId: string) => {
    setDraftScenario((prev) => ({
      ...prev,
      events: prev.events.filter((event) => event.id !== eventId),
    }));
  };

  const handleScenarioEventTypeChange = (eventId: string, type: ScenarioEvent['type']) => {
    updateDraftEvent(eventId, (event) => adaptEventForType({ ...event, type } as ScenarioEventDraft, type));
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
  const sortedDraftEvents = useMemo(
    () => [...draftScenario.events].sort((a, b) => a.offset - b.offset),
    [draftScenario.events],
  );
  const scenarioStateLabel = translateScenarioStatus(scenarioStatus.status);
  const nextScenarioEvent = describeScenarioEvent(scenarioStatus.nextEvent);
  const scenarioIsRunning = scenarioStatus.status === 'running';

  return (
    <div className="app-shell">
      <div className="app-surface">
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
            value={snapshot?.ugaActive ? 'Diffusion' : 'Repos'}
            tone={snapshot?.ugaActive ? 'critical' : 'neutral'}
            footer={snapshot?.ugaActive ? 'Sonorisation en cours' : 'Pré-alerte en veille'}
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

        <main className="app-main">
          <section className="app-column app-column--primary">
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

            <ManualEvacuationPanel
              manualActive={manualActive}
              reason={snapshot?.manualEvacuationReason}
              onStart={(reason) => sdk.startManualEvacuation(reason)}
              onStop={(reason) => sdk.stopManualEvacuation(reason)}
            />

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

          <section className="app-column app-column--secondary">
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

            <div className="card scenario-card">
              <div className="card__header">
                <h2 className="card__title">Scénarios personnalisés</h2>
                <p className="card__description">Composez vos exercices DAI/DM et diffusez-les instantanément auprès du poste apprenant.</p>
              </div>
              <div className="scenario-status">
                <div className="scenario-status__meta">
                  <span className="scenario-status__label">Scénario courant</span>
                  <strong className="scenario-status__name">{scenarioStatus.scenario?.name ?? 'Aucun scénario actif'}</strong>
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
                      return (
                        <div key={eventDraft.id} className="scenario-event-row">
                          <span className="scenario-event-row__index">#{index + 1}</span>
                          <label className="scenario-event-field scenario-event-field--offset">
                            <span>Offset (s)</span>
                            <input
                              type="number"
                              min={0}
                              step={0.1}
                              value={offsetValue}
                              onChange={(input) => {
                                const value = Number.parseFloat(input.target.value);
                                handleScenarioEventOffsetChange(eventDraft.id, Number.isNaN(value) ? 0 : value);
                              }}
                            />
                          </label>
                          <label className="scenario-event-field scenario-event-field--type">
                            <span>Action</span>
                            <select
                              value={eventDraft.type}
                              onChange={(input) =>
                                handleScenarioEventTypeChange(eventDraft.id, input.target.value as ScenarioEvent['type'])
                              }
                            >
                              {SCENARIO_EVENT_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          {zoneEvent && (
                            <label className="scenario-event-field scenario-event-field--zone">
                              <span>Zone</span>
                              <input
                                value={(eventDraft as { zoneId: string }).zoneId}
                                onChange={(input) => handleScenarioEventZoneChange(eventDraft.id, input.target.value)}
                                placeholder="ZF1"
                              />
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
                          <button
                            type="button"
                            className="scenario-event-remove"
                            onClick={() => handleScenarioRemoveEvent(eventDraft.id)}
                            aria-label={`Supprimer l'événement ${index + 1}`}
                          >
                            ×
                          </button>
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
        </main>
      </div>
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
