/** Tailwind text color class based on a percentage value (0–100+). */
export function pctColor(pct: number): string {
  if (pct >= 85) return 'text-red-500';
  if (pct >= 70) return 'text-orange-400';
  if (pct >= 50) return 'text-yellow-400';
  return 'text-emerald-400';
}

/** Tailwind background color class based on a percentage value (0–100+). */
export function pctBg(pct: number): string {
  if (pct >= 85) return 'bg-red-500';
  if (pct >= 70) return 'bg-orange-400';
  if (pct >= 50) return 'bg-yellow-400';
  return 'bg-emerald-400';
}

/** Tailwind text color class for source labels (Project / User / Plugin). */
export function srcColor(source: string): string {
  if (source === 'Project') return 'text-emerald-400';
  if (source === 'User') return 'text-yellow-400';
  if (source === 'Plugin') return 'text-violet-400';
  return 'text-blue-400';
}
