import { useCallback, useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { SsiSdk, type ScenarioRunnerSnapshot } from '@simu-ssi/sdk';

interface CmsiStateData {
  status: string;
  manual?: boolean;
  suspendFlag?: boolean;
  deadline?: number;
}

interface Snapshot {
  cmsi: CmsiStateData;
  ugaActive: boolean;
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

function translateScenarioStatus(status: ScenarioRunnerSnapshot['status']): string {
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

function describeScenarioEvent(event: ScenarioRunnerSnapshot['nextEvent']): string {
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

export function TraineeApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scenarioStatus, setScenarioStatus] = useState<ScenarioRunnerSnapshot>({ status: 'idle' });
  const [accessLevel, setAccessLevel] = useState<number>(1);
  const [ledMessage, setLedMessage] = useState<string>('Niveau 1 actif — arrêt signal sonore disponible.');
  const [codeBuffer, setCodeBuffer] = useState<string>('');
  const [verifyingAccess, setVerifyingAccess] = useState<boolean>(false);
  const baseUrl = useMemo(() => import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4500', []);
  const sdk = useMemo(() => new SsiSdk(baseUrl), [baseUrl]);

  useEffect(() => {
    const socket = io(baseUrl);
    socket.on('state.update', (state: Snapshot) => setSnapshot(state));
    socket.on('scenario.update', (status: ScenarioRunnerSnapshot) => setScenarioStatus(status));
    return () => socket.disconnect();
  }, [baseUrl]);

  useEffect(() => {
    sdk.getActiveScenario().then(setScenarioStatus).catch(console.error);
  }, [sdk]);

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
    ? Math.max(0, Math.floor((snapshot.cmsi.deadline - Date.now()) / 1000))
    : null;

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
        description: 'Alarme générale sonore',
        tone: 'alarm',
        active: Boolean(snapshot?.ugaActive),
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
          daiCount > 0 ? `${daiCount} détection(s) en cours` : 'Détection automatique incendie',
        tone: daiCount > 0 ? 'warning' : 'info',
        active: daiCount > 0,
      },
      ...dmModules,
    ];
  }, [snapshot]);

  const scenarioStatusLabel = translateScenarioStatus(scenarioStatus.status);
  const nextScenarioEvent = describeScenarioEvent(scenarioStatus.nextEvent);

  const cmsiMode = snapshot?.cmsi.manual ? 'Mode manuel' : 'Mode automatique';

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
            {boardModules.map((module) => (
              <BoardTile key={module.id} module={module} />
            ))}
          </div>
          <div className="control-strip">
            <ControlButton
              label="Arrêt signal sonore"
              tone="red"
              onClick={handleSilenceAlarm}
              disabled={!snapshot?.ugaActive}
              title={!snapshot?.ugaActive ? 'Aucune alarme sonore en cours' : undefined}
            />
            <ControlButton
              label="Acquittement"
              tone="amber"
              onClick={handleAck}
              disabled={accessLevel < 2}
              title={accessLevel < 2 ? 'Code niveau 2 requis' : undefined}
            />
            <ControlButton
              label="Demande de réarmement"
              tone="blue"
              onClick={handleResetRequest}
              disabled={accessLevel < 2}
              title={accessLevel < 2 ? 'Code niveau 2 requis' : undefined}
            />
            <ControlButton
              label="Réarmement DM ZF1"
              tone="green"
              onClick={() => handleResetDm('ZF1')}
              disabled={accessLevel < 2}
              title={accessLevel < 2 ? 'Code niveau 2 requis' : undefined}
            />
            <ControlButton
              label={snapshot?.manualEvacuation ? 'Arrêt évacuation manuelle' : 'Déclencher évacuation manuelle'}
              tone={snapshot?.manualEvacuation ? 'blue' : 'purple'}
              onClick={handleManualEvacToggle}
              disabled={accessLevel < 2}
              title={accessLevel < 2 ? 'Code niveau 2 requis' : undefined}
            />
          </div>
        </section>
        <section className="side-panels">
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
                <span className="detail-label">UGA</span>
                <span className="detail-value">{snapshot?.ugaActive ? 'Active' : 'Arrêtée'}</span>
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
                  {scenarioStatus.scenario?.name ? `${scenarioStatus.scenario.name} (${scenarioStatusLabel})` : scenarioStatusLabel}
                </span>
              </li>
              <li>
                <span className="detail-label">Prochain événement</span>
                <span className="detail-value">{nextScenarioEvent}</span>
              </li>
            </ul>
          </article>
          <article className="detail-panel">
            <h3 className="detail-title">Consignes Apprenant</h3>
            <p className="instruction-text">
              Surveillez l&apos;évolution du synoptique, vérifiez les zones en alarme et appliquez la procédure
              d&apos;acquittement avant de réarmer le système. Utilisez les boutons du bandeau de commande pour
              reproduire fidèlement les actions terrain.
            </p>
            <p className="instruction-text">
              Lorsque plusieurs déclencheurs manuels sont actifs, procédez au réarmement zone par zone afin
              d&apos;observer les retours d&apos;information dans le tableau répétiteur.
            </p>
          </article>
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
