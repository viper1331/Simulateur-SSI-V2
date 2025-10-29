import { useEffect, useMemo, useState } from 'react';
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

export function App() {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [snapshot, setSnapshot] = useState<DomainSnapshot | null>(null);
  const [events, setEvents] = useState<string[]>([]);

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

  const remainingMs = snapshot?.cmsi?.deadline ? snapshot.cmsi.deadline - Date.now() : undefined;

  return (
    <div className="min-h-screen bg-slate-100 p-6 text-slate-900">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Console Formateur — Simulateur SSI Cat. A</h1>
          <p className="text-sm text-slate-600">Pilotez les scénarios FPSSI, surveillez les états et orchestrez les formations.</p>
        </div>
        <div className="rounded-lg bg-white px-4 py-2 shadow">
          <kbd className="mr-2 rounded border px-2 py-1 text-xs">Ctrl+M</kbd>
          Déclencher — <kbd className="ml-2 rounded border px-2 py-1 text-xs">Ctrl+Shift+M</kbd> Arrêt
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-4">
        <StatusTile title="CMSI" value={snapshot?.cmsi?.status ?? '—'} tone={deriveTone(snapshot)} />
        <StatusTile title="UGA" value={snapshot?.ugaActive ? 'En diffusion' : 'Repos'} tone={snapshot?.ugaActive ? 'critical' : 'neutral'} />
        <StatusTile title="DAS" value={snapshot?.dasApplied ? 'Appliqués' : 'Sécurisés'} tone={snapshot?.dasApplied ? 'warning' : 'neutral'} />
        <StatusTile title="Process Ack" value={snapshot?.processAck?.isAcked ? 'Fourni' : 'Requis'} tone={snapshot?.processAck?.isAcked ? 'success' : 'warning'} />
      </section>

      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold">Chronogramme d'évacuation</h2>
          <p className="text-sm text-slate-600">Suivez le compte à rebours T+5 et les transitions d'état.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            {snapshot?.cmsi?.status === 'EVAC_PENDING' && (
              <TimelineBadge label="EvacPending" state="pending" remainingMs={remainingMs} />
            )}
            {snapshot?.cmsi?.status === 'EVAC_ACTIVE' && (
              <TimelineBadge label={snapshot.cmsi.manual ? 'Manuelle' : 'Automatique'} state="active" />
            )}
            {snapshot?.cmsi?.status === 'EVAC_SUSPENDED' && <TimelineBadge label="Suspension" state="suspended" />}
            {snapshot?.cmsi?.status === 'SAFE_HOLD' && <TimelineBadge label="SafeHold" state="safehold" />}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold">Configuration site</h2>
          <form className="mt-3 space-y-3" onSubmit={handleConfigSubmit}>
            <label className="block text-sm font-medium text-slate-700">
              Délai T+5 (ms)
              <input
                name="delay"
                type="number"
                min={1000}
                defaultValue={config?.evacOnDMDelayMs ?? 300000}
                className="mt-1 w-full rounded border border-slate-300 p-2"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input name="processAckRequired" type="checkbox" defaultChecked={config?.processAckRequired ?? true} />
              Acquit Process obligatoire
            </label>
            <button type="submit" className="rounded bg-slate-900 px-4 py-2 text-white hover:bg-slate-700">
              Appliquer
            </button>
          </form>
        </div>
      </section>

      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <ManualEvacuationPanel
          manualActive={Boolean(snapshot?.manualEvacuation)}
          reason={snapshot?.manualEvacuationReason}
          onStart={(reason) => sdk.startManualEvacuation(reason).catch(console.error)}
          onStop={(reason) => sdk.stopManualEvacuation(reason).catch(console.error)}
        />
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold">Déclenchements DM latched</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {Object.values(snapshot?.dmLatched ?? {}).length === 0 && <li>Aucun DM en cours.</li>}
            {Object.values(snapshot?.dmLatched ?? {}).map((dm) => (
              <li key={dm.zoneId} className="flex items-center justify-between rounded border border-slate-200 p-2">
                <span>
                  Zone {dm.zoneId}
                  {dm.lastActivatedAt ? (
                    <span className="ml-2 text-xs text-slate-500">
                      {new Date(dm.lastActivatedAt).toLocaleTimeString()}
                    </span>
                  ) : null}
                </span>
                <button
                  className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
                  onClick={() => sdk.resetManualCallPoint(dm.zoneId).catch(console.error)}
                >
                  Réarmer
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold">Journal temps réel</h2>
          <ul className="mt-3 space-y-1 text-xs font-mono">
            {events.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold">Actions rapides</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
              onClick={() => sdk.acknowledgeProcess('trainer').catch(console.error)}
            >
              Acquit Process
            </button>
            <button
              className="rounded bg-slate-900 px-4 py-2 text-white hover:bg-slate-700"
              onClick={() => sdk.clearProcessAck().catch(console.error)}
            >
              Effacer Acquit
            </button>
            <button
              className="rounded bg-amber-600 px-4 py-2 text-white hover:bg-amber-700"
              onClick={() => sdk.activateManualCallPoint('ZF1').catch(console.error)}
            >
              Simuler DM ZF1
            </button>
            <button
              className="rounded bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700"
              onClick={() =>
                sdk
                  .resetSystem()
                  .then(() => sdk.clearProcessAck())
                  .catch((error) => console.error(error))
              }
            >
              Demande Reset
            </button>
          </div>
        </div>
      </section>
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
