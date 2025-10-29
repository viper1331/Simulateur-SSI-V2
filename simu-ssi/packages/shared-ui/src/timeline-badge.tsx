interface TimelineBadgeProps {
  label: string;
  state: 'pending' | 'active' | 'suspended' | 'safehold';
  remainingMs?: number;
}

export function TimelineBadge({ label, state, remainingMs }: TimelineBadgeProps) {
  const colors: Record<typeof state, string> = {
    pending: 'bg-amber-500',
    active: 'bg-red-600',
    suspended: 'bg-blue-600',
    safehold: 'bg-emerald-600',
  } as const;
  const format = () => {
    if (remainingMs == null) return '';
    const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-white ${colors[state]}`}>
      <span className="font-semibold uppercase tracking-wide">{label}</span>
      {remainingMs != null ? <span className="text-sm font-mono">{format()}</span> : null}
    </span>
  );
}
