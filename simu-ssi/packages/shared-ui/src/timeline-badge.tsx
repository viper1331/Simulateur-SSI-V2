import { clsx } from 'clsx';

interface TimelineBadgeProps {
  label: string;
  state: 'pending' | 'active' | 'suspended' | 'safehold';
  remainingMs?: number;
}

export function TimelineBadge({ label, state, remainingMs }: TimelineBadgeProps) {
  const tone = {
    pending: 'timeline-badge--pending',
    active: 'timeline-badge--active',
    suspended: 'timeline-badge--suspended',
    safehold: 'timeline-badge--safehold',
  }[state];

  const format = () => {
    if (remainingMs == null) return '';
    const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <span className={clsx('timeline-badge', tone)}>
      <span className="timeline-badge__label">{label}</span>
      {remainingMs != null ? <span className="timeline-badge__timer">{format()}</span> : null}
    </span>
  );
}
