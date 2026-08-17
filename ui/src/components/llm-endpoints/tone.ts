/**
 * The one set of badge/chip tones the LLM endpoint screens use — outline
 * border, faint fill, coloured text — so a "no key" chip in the list, the
 * chain tree and the credential field read as the same thing.
 */
export const TONE = {
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-500',
  emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
  destructive: 'border-destructive/30 bg-destructive/10 text-destructive',
  sky: 'border-sky-500/30 bg-sky-500/10 text-sky-500',
  violet: 'border-violet-500/30 bg-violet-500/10 text-violet-500',
} as const;

export type Tone = keyof typeof TONE;
