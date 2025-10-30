import { useState, type FormEvent } from 'react';

interface ManualEvacuationPanelProps {
  manualActive: boolean;
  reason?: string;
  onStart(reason?: string): Promise<void> | void;
  onStop(reason?: string): Promise<void> | void;
}

export function ManualEvacuationPanel({ manualActive, reason, onStart, onStop }: ManualEvacuationPanelProps) {
  const [startPending, setStartPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);

  const handleStart = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (manualActive || startPending) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    try {
      setStartPending(true);
      await onStart(formData.get('reason')?.toString() ?? undefined);
      form.reset();
    } catch (error) {
      console.error(error);
    } finally {
      setStartPending(false);
    }
  };

  const handleStop = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!manualActive || stopPending) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    try {
      setStopPending(true);
      await onStop(formData.get('reason')?.toString() ?? undefined);
      form.reset();
    } catch (error) {
      console.error(error);
    } finally {
      setStopPending(false);
    }
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
        <form
          onSubmit={handleStart}
          aria-label="Start manual evacuation"
          aria-busy={startPending}
        >
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Motif de déclenchement
            <input
              name="reason"
              className="mt-1 w-full rounded border border-slate-300 p-2"
              placeholder="Ex: Exercice, dérangement"
              disabled={manualActive || startPending}
            />
          </label>
          <button
            type="submit"
            disabled={manualActive || startPending}
            className="w-full rounded bg-red-600 py-2 text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {startPending ? 'Déclenchement…' : 'Déclencher'}
          </button>
        </form>
        <form
          onSubmit={handleStop}
          aria-label="Stop manual evacuation"
          aria-busy={stopPending}
        >
          <label className="mb-2 block text-sm font-medium text-slate-700">
            Motif d'arrêt
            <input
              name="reason"
              className="mt-1 w-full rounded border border-slate-300 p-2"
              placeholder="Ex: Retour conditions normales"
              disabled={!manualActive || stopPending}
            />
          </label>
          <button
            type="submit"
            disabled={!manualActive || stopPending}
            className="w-full rounded bg-slate-900 py-2 text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {stopPending ? 'Arrêt…' : 'Arrêter'}
          </button>
        </form>
      </div>
      <p className="mt-3 text-xs text-slate-500" aria-live="polite">
        {reason ? `Dernier motif : ${reason}` : 'Aucun motif enregistré.'}
      </p>
    </div>
  );
}
