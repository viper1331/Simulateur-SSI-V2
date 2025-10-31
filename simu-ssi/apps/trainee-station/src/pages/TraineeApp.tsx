import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import {
  DEFAULT_TRAINEE_LAYOUT,
  SsiSdk,
  traineeLayoutSchema,
  siteTopologySchema,
  type SiteTopology,
  type ScenarioRunnerSnapshot,
  type TraineeLayoutConfig,
} from '@simu-ssi/sdk';

interface CmsiStateData {
  status: string;
  manual?: boolean;
  suspendFlag?: boolean;
  deadline?: number;
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

function extractPlanNotes(topology: SiteTopology | null): string[] {
  if (!topology) {
    return [];
  }
  const notes = new Set<string>();
  for (const device of topology.devices) {
    const props = device.props as Record<string, unknown> | undefined;
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
  return Array.from(notes);
}

export function TraineeApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [scenarioStatus, setScenarioStatus] = useState<ScenarioRunnerSnapshot>({ status: 'idle' });
  const [accessLevel, setAccessLevel] = useState<number>(1);
  const [ledMessage, setLedMessage] = useState<string>('Niveau 1 actif — arrêt signal sonore disponible.');
  const [codeBuffer, setCodeBuffer] = useState<string>('');
  const [verifyingAccess, setVerifyingAccess] = useState<boolean>(false);
  const [layout, setLayout] = useState<TraineeLayoutConfig>(DEFAULT_TRAINEE_LAYOUT);
  const [topology, setTopology] = useState<SiteTopology | null>(null);
  const [planNotes, setPlanNotes] = useState<string[]>([]);
  const baseUrl = useMemo(() => import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4500', []);
  const sdk = useMemo(() => new SsiSdk(baseUrl), [baseUrl]);

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
      if (parsed.success) {
        setTopology(parsed.data);
      }
    });
    return () => socket.disconnect();
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
    sdk
      .getTopology()
      .then((data) => setTopology(data))
      .catch((error) => console.error(error));
  }, [sdk]);

  useEffect(() => {
    setPlanNotes(extractPlanNotes(topology));
  }, [topology]);

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem('ssi-access-level');
      if (stored) {
        const parsed = Number.parseInt(stored, 10);
        if (parsed === 2) {
          setAccessLevel(2);
          setLedMessage('Niveau 2 actif — commandes avancées disponibles.');
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
    sdk.resetSystem().catch(console.error);
  }, [accessLevel, sdk]);

  const handleResetDm = useCallback(
    (zoneId: string) => {
      if (accessLevel < 2) return;
      sdk.resetManualCallPoint(zoneId).catch(console.error);
    },
    [accessLevel, sdk],
  );

  const handleManualEvacToggle = useCallback(() => {
    if (accessLevel < 2) return;
    if (snapshot?.manualEvacuation) {
      sdk.stopManualEvacuation('poste-apprenant').catch(console.error);
    } else {
      sdk.startManualEvacuation('poste-apprenant').catch(console.error);
    }
  }, [accessLevel, sdk, snapshot?.manualEvacuation]);

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
    setAccessLevel(1);
    setLedMessage('Niveau 1 actif — arrêt signal sonore disponible.');
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
      }
    } catch (error) {
      console.error(error);
      setLedMessage('Erreur de vérification du code.');
    } finally {
      setVerifyingAccess(false);
      setCodeBuffer('');
    }
  }, [codeBuffer, handleAccessLock, sdk, verifyingAccess]);

  const remainingDeadline = snapshot?.cmsi.deadline
    ? Math.max(0, Math.floor((snapshot.cmsi.deadline - now) / 1000))
    : null;

  const anyAudible = Boolean(snapshot?.ugaActive || snapshot?.localAudibleActive);
  const localAudibleOnly = Boolean(snapshot?.localAudibleActive && !snapshot?.ugaActive);

  const boardModules: BoardModule[] = useMemo(() => {
    const daiCount = Object.keys(snapshot?.daiActivated ?? {}).length;
    const dmModules: BoardModule[] = Array.from({ length: 8 }, (_, index) => {
      const zone = `ZF${index + 1}`;
      const isLatched = Boolean(snapshot?.dmLatched?.[zone]);
      return {
        id: `dm-${zone.toLowerCase()}`,
        label: zone,
        description: `Déclencheur manuel ${zone}`,
        tone: 'warning',
        active: isLatched,
      };
    });

    return [
      {
        id: 'cmsi-status',
        label: 'CMSI',
        description: cmsiStatusLabel[snapshot?.cmsi.status ?? ''] ?? 'Système normal',
        tone: cmsiStatusTone[snapshot?.cmsi.status ?? ''] ?? 'info',
        active: Boolean(snapshot?.cmsi.status && snapshot.cmsi.status !== 'IDLE'),
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
      },
      {
        id: 'das',
        label: 'DAS',
        description: 'Dispositifs actionnés de sécurité',
        tone: 'warning',
        active: Boolean(snapshot?.dasApplied),
      },
      {
        id: 'manual-evac',
        label: 'Manuel',
        description: 'Commande manuelle évacuation',
        tone: 'info',
        active: Boolean(snapshot?.manualEvacuation),
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
      },
      ...dmModules,
    ];
  }, [snapshot, anyAudible, localAudibleOnly]);

  const orderedBoardModules = useMemo(
    () => orderItems(boardModules, layout.boardModuleOrder, layout.boardModuleHidden ?? []),
    [boardModules, layout.boardModuleOrder, layout.boardModuleHidden],
  );

  const scenarioStatusLabel = translateScenarioStatus(
    scenarioStatus.status,
    scenarioStatus.awaitingSystemReset,
  );
  const nextScenarioEvent = describeScenarioEvent(scenarioStatus);

  const cmsiMode = snapshot?.cmsi.manual ? 'Mode manuel' : 'Mode automatique';

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
      disabled: accessLevel < 2,
      title: accessLevel < 2 ? 'Code niveau 2 requis' : undefined,
    },
    {
      id: 'reset-dm-zf1',
      label: 'Réarmement DM ZF1',
      tone: 'green',
      onClick: () => handleResetDm('ZF1'),
      disabled: accessLevel < 2,
      title: accessLevel < 2 ? 'Code niveau 2 requis' : undefined,
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

  const orderedControlButtons = orderItems(
    controlButtons,
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
              <span className="detail-value">{snapshot?.cmsi.suspendFlag ? 'Active' : 'Inactive'}</span>
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
                {scenarioStatus.scenario?.name
                  ? `${scenarioStatus.scenario.name} (${scenarioStatusLabel})`
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
        <article className="detail-panel">
          <h3 className="detail-title">Consignes Apprenant</h3>
          {planNotes.length > 0 ? (
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
      <header className="trainee-header">
          <div className="header-identification">
            <div className="header-titles">
              <span className="brand">Logiciel de simulation SSI</span>
              <h1 className="title">Poste Apprenant – Façade CMSI</h1>
            </div>
            <div className={`scenario-chip scenario-chip--${scenarioStatus.status}`}>
              {scenarioStatus.scenario?.name ?? 'Scénario libre'} · {scenarioStatusLabel}
            </div>
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
              />
            ))}
          </div>
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
}

interface ControlButtonItem extends ControlButtonProps {
  id: string;
}

function ControlButton({ label, tone, onClick, disabled, title }: ControlButtonProps) {
  return (
    <button
      type="button"
      className={`control-button control-${tone}`}
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
    <div className={`board-tile tone-${module.tone} ${module.active ? 'is-active' : ''}`}>
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
