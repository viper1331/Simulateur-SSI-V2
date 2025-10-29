import { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { SsiSdk } from '@simu-ssi/sdk';

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
}

export function TraineeApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const baseUrl = useMemo(() => import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4500', []);
  const sdk = useMemo(() => new SsiSdk(baseUrl), [baseUrl]);

  useEffect(() => {
    const socket = io(baseUrl);
    socket.on('state.update', (state: Snapshot) => setSnapshot(state));
    return () => socket.disconnect();
  }, [baseUrl]);

  const handleAck = () => sdk.acknowledgeProcess('trainee').catch(console.error);
  const handleResetRequest = () => sdk.resetSystem().catch(console.error);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-50">
      <header className="bg-slate-950 p-4 shadow">
        <h1 className="text-2xl font-bold uppercase tracking-wide">Façade CMSI pédagogique</h1>
      </header>
      <main className="grid gap-4 p-6 md:grid-cols-[2fr_1fr]">
        <section className="space-y-4 rounded-lg bg-slate-800 p-4 shadow-inner">
          <h2 className="text-xl font-semibold uppercase tracking-wide text-amber-200">Voyants CMSI</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <Indicator label="Alarme générale" active={snapshot?.cmsi.status === 'EVAC_ACTIVE'} tone="red" />
            <Indicator label="DAI Préalarme" active={snapshot?.cmsi.status === 'EVAC_PENDING'} tone="amber" />
            <Indicator label="Suspension Acquit" active={snapshot?.cmsi.status === 'EVAC_SUSPENDED'} tone="blue" />
            <Indicator label="SafeHold" active={snapshot?.cmsi.status === 'SAFE_HOLD'} tone="green" />
          </div>
          <div className="rounded bg-slate-900 p-3 font-mono text-sm">
            T+5 :{' '}
            {snapshot?.cmsi.deadline
              ? `${Math.max(0, Math.floor((snapshot.cmsi.deadline - Date.now()) / 1000))}s`
              : '—'}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="rounded bg-amber-500 px-3 py-2 font-semibold text-slate-950" onClick={handleAck}>
              Acquittement
            </button>
            <button
              className="rounded bg-emerald-500 px-3 py-2 font-semibold text-slate-900"
              onClick={() => sdk.resetManualCallPoint('ZF1').catch(console.error)}
            >
              Réarmement DM ZF1
            </button>
            <button className="rounded bg-slate-100 px-3 py-2 font-semibold text-slate-900" onClick={handleResetRequest}>
              Demande Reset
            </button>
          </div>
        </section>
        <aside className="space-y-4 rounded-lg bg-slate-800 p-4">
          <h2 className="text-xl font-semibold uppercase tracking-wide text-amber-200">Répétiteur</h2>
          <p className="text-sm text-slate-200">
            {snapshot?.cmsi.status === 'EVAC_ACTIVE'
              ? 'ÉVACUATION EN COURS — UGA ACTIVE'
              : snapshot?.cmsi.status === 'EVAC_PENDING'
                ? 'PRÉALARME — EN ATTENTE ACQUIT'
                : snapshot?.cmsi.status === 'EVAC_SUSPENDED'
                  ? 'SUSPENDU — ATTENTE RÉARMEMENT'
                  : 'SYSTÈME NORMAL'}
          </p>
          <div className="rounded bg-slate-900 p-3 text-sm">
            DM latched : {Object.keys(snapshot?.dmLatched ?? {}).length}
          </div>
        </aside>
      </main>
      <footer className="bg-slate-950 p-3 text-center text-xs text-slate-400">
        Raccourcis clavier : Ctrl+M déclenchement, Ctrl+Shift+M arrêt.
      </footer>
    </div>
  );
}

interface IndicatorProps {
  label: string;
  active?: boolean;
  tone: 'red' | 'amber' | 'blue' | 'green';
}

function Indicator({ label, active, tone }: IndicatorProps) {
  const colors: Record<IndicatorProps['tone'], string> = {
    red: 'bg-red-500',
    amber: 'bg-amber-400',
    blue: 'bg-blue-500',
    green: 'bg-emerald-500',
  };
  return (
    <div className="flex items-center justify-between rounded border border-slate-700 bg-slate-900 px-3 py-2">
      <span className="text-sm font-semibold uppercase tracking-wide">{label}</span>
      <span className={`h-4 w-4 rounded-full ${active ? colors[tone] : 'bg-slate-700'}`} aria-hidden />
    </div>
  );
}
