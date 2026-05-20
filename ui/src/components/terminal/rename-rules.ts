const TYPEID_RX = /^[a-z][a-z0-9_-]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function allowRename(name: string | null | undefined): boolean {
  const n = (name ?? '').trim();
  if (!n) return false;
  if (TYPEID_RX.test(n)) return false;
  if (n.includes('Claude Code')) return false;
  return true;
}
