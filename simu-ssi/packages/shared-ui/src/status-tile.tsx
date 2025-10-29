import type { ReactNode } from 'react';
import { clsx } from 'clsx';

interface StatusTileProps {
  title: string;
  value: ReactNode;
  tone?: 'neutral' | 'warning' | 'critical' | 'success';
  footer?: ReactNode;
}

export function StatusTile({ title, value, tone = 'neutral', footer }: StatusTileProps) {
  return (
    <div
      className={clsx(
        'rounded-md border p-4 shadow-sm transition-colors',
        tone === 'neutral' && 'border-slate-200 bg-white',
        tone === 'warning' && 'border-amber-400 bg-amber-50',
        tone === 'critical' && 'border-red-500 bg-red-50',
        tone === 'success' && 'border-emerald-500 bg-emerald-50',
      )}
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </div>
      <div className="mt-2 text-2xl font-bold text-slate-900">{value}</div>
      {footer ? <div className="mt-3 text-sm text-slate-600">{footer}</div> : null}
    </div>
  );
}
