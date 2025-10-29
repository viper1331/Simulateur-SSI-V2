import { useMemo, useState } from 'react';
import { SsiSdk } from '@simu-ssi/sdk';

interface DevicePlacement {
  id: string;
  label: string;
  kind: 'DM' | 'DAI' | 'DAS' | 'UGA';
  x: number;
  y: number;
}

export function AdminStudioApp() {
  const baseUrl = useMemo(() => import.meta.env.VITE_SERVER_URL ?? 'http://localhost:4500', []);
  useMemo(() => new SsiSdk(baseUrl), [baseUrl]);
  const [plan, setPlan] = useState<DevicePlacement[]>([]);

  return (
    <div className="min-h-screen bg-slate-100 p-6 text-slate-900">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Studio Administrateur</h1>
        <p className="text-sm text-slate-600">
          Importez des plans, positionnez ZD/ZF et configurez les scénarios industriels FPSSI.
        </p>
      </header>
      <main className="grid gap-4 md:grid-cols-[2fr_1fr]">
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold">Plan interactif</h2>
          <div className="mt-3 flex h-96 items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50">
            <span className="text-sm text-slate-500">Glissez vos dispositifs ici (prototype)</span>
          </div>
        </section>
        <aside className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold">Dispositifs</h2>
          <ul className="space-y-2 text-sm">
            {plan.length === 0 && <li>Aucun dispositif placé.</li>}
            {plan.map((device) => (
              <li key={device.id} className="flex items-center justify-between rounded border border-slate-200 p-2">
                <span>{device.kind} — {device.label}</span>
                <span className="text-xs text-slate-500">
                  ({Math.round(device.x)}, {Math.round(device.y)})
                </span>
              </li>
            ))}
          </ul>
          <button
            className="w-full rounded bg-slate-900 px-4 py-2 text-white hover:bg-slate-700"
            onClick={() =>
              setPlan((previous) => [
                ...previous,
                {
                  id: `dm-${previous.length + 1}`,
                  label: `DM ${previous.length + 1}`,
                  kind: 'DM',
                  x: Math.random() * 100,
                  y: Math.random() * 100,
                },
              ])
            }
          >
            Ajouter un DM fictif
          </button>
        </aside>
      </main>
    </div>
  );
}
