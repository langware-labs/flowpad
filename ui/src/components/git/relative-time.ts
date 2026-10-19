/** Coarse "how long ago" label for picker rows (shared by the repo + branch pickers). */
export function formatRelative(iso: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso.slice(0, 10);
  const ageMs = Date.now() - then;
  const days = Math.floor(ageMs / 86_400_000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
