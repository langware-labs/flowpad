export type BidiDir = 'ltr' | 'rtl' | null;
export type BidiAlign = 'start' | 'end' | 'center' | 'justify' | null;

const VALID_DIRS: ReadonlySet<string> = new Set(['ltr', 'rtl']);
const VALID_ALIGNS: ReadonlySet<string> = new Set(['start', 'end', 'center', 'justify']);

export function normalizeDir(value: unknown): BidiDir {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return VALID_DIRS.has(v) ? (v as 'ltr' | 'rtl') : null;
}

export function normalizeAlign(value: unknown): BidiAlign {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return VALID_ALIGNS.has(v) ? (v as Exclude<BidiAlign, null>) : null;
}

export function parseAlignFromStyle(style: string | null | undefined): BidiAlign {
  if (!style) return null;
  return normalizeAlign(/text-align\s*:\s*([\w-]+)/i.exec(style)?.[1]);
}
