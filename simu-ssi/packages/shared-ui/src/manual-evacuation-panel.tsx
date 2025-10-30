import { useState, type FormEvent } from 'react';
import { clsx } from 'clsx';

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
    <section className="card manual-panel">
      <div className="card__header manual-panel__header">
        <div>
          <p className="card__eyebrow">Évacuation manuelle</p>
          <h2 className="card__title">Pilotage opérateur</h2>
          <p className="card__description">
            Déclenchez ou interrompez une évacuation maîtrisée, et journalisez chaque motif pour la traçabilité.
          </p>
        </div>
        <span
          className={clsx('badge', manualActive ? 'badge--alert' : 'badge--success')}
          aria-live="polite"
        >
          {manualActive ? 'Active' : 'Disponible'}
        </span>
      </div>
      <div className="manual-panel__forms">
        <form onSubmit={handleStart} aria-label="Start manual evacuation" aria-busy={startPending}>
          <label className="form-field">
            <span className="form-field__label">Motif de déclenchement</span>
            <input
              name="reason"
              className="text-input"
              placeholder="Ex: Exercice, dérangement"
              disabled={manualActive || startPending}
            />
          </label>
          <button
            type="submit"
            disabled={manualActive || startPending}
            className="btn btn--warning"
          >
            {startPending ? 'Déclenchement…' : 'Déclencher'}
          </button>
        </form>
        <form onSubmit={handleStop} aria-label="Stop manual evacuation" aria-busy={stopPending}>
          <label className="form-field">
            <span className="form-field__label">Motif d'arrêt</span>
            <input
              name="reason"
              className="text-input"
              placeholder="Ex: Retour conditions normales"
              disabled={!manualActive || stopPending}
            />
          </label>
          <button
            type="submit"
            disabled={!manualActive || stopPending}
            className="btn btn--ghost"
          >
            {stopPending ? 'Arrêt…' : 'Arrêter'}
          </button>
        </form>
      </div>
      <p className="manual-panel__footer" aria-live="polite">
        {reason ? `Dernier motif : ${reason}` : 'Aucun motif enregistré.'}
      </p>
    </section>
  );
}
