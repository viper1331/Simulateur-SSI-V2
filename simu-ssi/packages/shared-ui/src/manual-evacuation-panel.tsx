import type { FormEvent } from 'react';

interface ManualEvacuationPanelProps {
  manualActive: boolean;
  reason?: string;
  onStart(reason?: string): void;
  onStop(reason?: string): void;
}

export function ManualEvacuationPanel({ manualActive, reason, onStart, onStop }: ManualEvacuationPanelProps) {
  const handleStart = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    onStart(formData.get('reason')?.toString() ?? undefined);
    event.currentTarget.reset();
  };

  const handleStop = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    onStop(formData.get('reason')?.toString() ?? undefined);
    event.currentTarget.reset();
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Évacuation manuelle</h2>
          <p className="text-sm text-slate-600">
            {manualActive ? 'Manuelle active — confirmez l\'arrêt si nécessaire.' : 'Déclenchez une évacuation manuelle avec confirmation.'}
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-sm font-semibold ${manualActive ? 'bg-red-600 text-white' : 'bg-emerald-100 text-emerald-700'}`}
        >
          {manualActive ? 'Active' : 'Inactive'}
        </span>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <form onSubmit={handleStart} aria-label="Start manual evacuation">
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Motif de déclenchement
            <input
              name="reason"
              className="mt-1 w-full rounded border border-slate-300 p-2"
              placeholder="Ex: Exercice, dérangement"
              disabled={manualActive}
            />
          </label>
          <button
            type="submit"
            disabled={manualActive}
            className="w-full rounded bg-red-600 py-2 text-white transition hover:bg-red-700 disabled:bg-slate-300"
          >
            Déclencher
          </button>
        </form>
        <form onSubmit={handleStop} aria-label="Stop manual evacuation">
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Motif d'arrêt
            <input
              name="reason"
              className="mt-1 w-full rounded border border-slate-300 p-2"
              placeholder="Ex: Retour conditions normales"
              disabled={!manualActive}
            />
          </label>
          <button
            type="submit"
            disabled={!manualActive}
            className="w-full rounded bg-slate-900 py-2 text-white transition hover:bg-slate-700 disabled:bg-slate-300"
          >
            Arrêter
          </button>
        </form>
      </div>
      {reason ? <p className="mt-3 text-xs text-slate-500">Dernier motif : {reason}</p> : null}
    </div>
  );
}
