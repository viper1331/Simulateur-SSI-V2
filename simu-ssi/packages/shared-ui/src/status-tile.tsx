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
        'status-tile',
        tone === 'neutral' && 'status-tile--neutral',
        tone === 'warning' && 'status-tile--warning',
        tone === 'critical' && 'status-tile--critical',
        tone === 'success' && 'status-tile--success',
      )}
    >
      <div className="status-tile__label">{title}</div>
      <div className="status-tile__value">{value}</div>
      {footer ? <div className="status-tile__footer">{footer}</div> : null}
    </div>
  );
}
