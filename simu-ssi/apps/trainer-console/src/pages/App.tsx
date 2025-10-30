import { useCallback, useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { ManualEvacuationPanel, StatusTile, TimelineBadge } from '@simu-ssi/shared-ui';
import { SsiSdk, type SiteConfig } from '@simu-ssi/sdk';

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

export function App() {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [snapshot, setSnapshot] = useState<DomainSnapshot | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [ackPending, setAckPending] = useState(false);
  const [clearPending, setClearPending] = useState(false);
  const [simulateDmPending, setSimulateDmPending] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [resettingZone, setResettingZone] = useState<string | null>(null);

  const baseUrl = useMemo(() => import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4500', []);
  const sdk = useMemo(() => new SsiSdk(baseUrl), [baseUrl]);

  useEffect(() => {
    sdk.getSiteConfig().then(setConfig).catch(console.error);
    const socket = io(baseUrl);
    socket.on('state.update', (state: DomainSnapshot) => setSnapshot(state));
    socket.on('events.append', (event: { ts: number; message: string; source: string }) => {
      setEvents((prev) => [`[${new Date(event.ts).toLocaleTimeString()}] ${event.source}: ${event.message}`, ...prev].slice(0, 12));
    });
    return () => {
      socket.disconnect();
    };
  }, [baseUrl, sdk]);

  const handleConfigSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const delay = Number(data.get('delay'));
    const processAckRequired = data.get('processAckRequired') === 'on';
    const updated = await sdk.updateSiteConfig({ evacOnDMDelayMs: delay, processAckRequired });
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

  const remainingMs = snapshot?.cmsi?.deadline ? snapshot.cmsi.deadline - Date.now() : undefined;
  const dmList = Object.values(snapshot?.dmLatched ?? {});
  const manualActive = Boolean(snapshot?.manualEvacuation);

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
                  className="btn btn--success"
                  onClick={handleResetSystem}
                  disabled={resetPending}
                  aria-busy={resetPending}
                >
                  {resetPending ? 'Reset en cours…' : 'Demander un reset'}
                </button>
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
