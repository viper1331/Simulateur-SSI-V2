import { useEffect, useMemo, useState } from 'react';
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

  const handleAck = () => sdk.acknowledgeProcess('trainee').catch(console.error);
  const handleResetRequest = () => sdk.resetSystem().catch(console.error);
  const handleResetDm = (zoneId: string) => sdk.resetManualCallPoint(zoneId).catch(console.error);

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
            <ControlButton label="Acquittement" tone="amber" onClick={handleAck} />
            <ControlButton label="Demande de réarmement" tone="blue" onClick={handleResetRequest} />
            <ControlButton label="Réarmement DM ZF1" tone="green" onClick={() => handleResetDm('ZF1')} />
          </div>
        </section>
        <section className="side-panels">
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
  tone: 'amber' | 'blue' | 'green';
  onClick: () => void;
}

function ControlButton({ label, tone, onClick }: ControlButtonProps) {
  return (
    <button type="button" className={`control-button control-${tone}`} onClick={onClick}>
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
