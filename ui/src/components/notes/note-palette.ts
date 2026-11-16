/**
 * Sticky-note colours. Tokens share names with `ENTITY_COLOR_PALETTE`
 * (`@src/lib/color-palette`), but the values are paper tones, not text colours:
 * `face` is the note's gradient (light → dark), `fold` the crease line and the
 * flap's shadowed edge, `flap` the lit tip of the curled corner.
 */
export interface NoteColor {
  token: NoteColorToken;
  face: [string, string];
  fold: string;
  flap: string;
  /** Text on the note: dark enough to read on its own face. */
  ink: string;
}

export const NOTE_COLOR_TOKENS = [
  'yellow',
  'pink',
  'blue',
  'green',
  'orange',
  'violet',
  'red',
  'teal',
  'gray',
] as const;
export type NoteColorToken = (typeof NOTE_COLOR_TOKENS)[number];

export const DEFAULT_NOTE_COLOR: NoteColorToken = 'yellow';

export const NOTE_PALETTE: Record<NoteColorToken, NoteColor> = {
  yellow: { token: 'yellow', face: ['#FFEB6B', '#FFD83A'], fold: '#E3AE00', flap: '#FFF6BF', ink: '#3d2e00' },
  pink: { token: 'pink', face: ['#FFB3D1', '#FF8CBB'], fold: '#D94F8A', flap: '#FFE0EE', ink: '#4a0f2a' },
  blue: { token: 'blue', face: ['#9FD8FF', '#6EC1FF'], fold: '#2F8FD6', flap: '#DDF1FF', ink: '#0b2c47' },
  green: { token: 'green', face: ['#B6EFA0', '#8FE07A'], fold: '#4AA83A', flap: '#E4FAD9', ink: '#123d0b' },
  orange: { token: 'orange', face: ['#FFC58A', '#FFA953'], fold: '#D97A1C', flap: '#FFE6CC', ink: '#4a2400' },
  violet: { token: 'violet', face: ['#D4BBFF', '#B897FF'], fold: '#7A55D6', flap: '#EEE4FF', ink: '#2a1457' },
  red: { token: 'red', face: ['#FF9E9E', '#FF7676'], fold: '#D63B3B', flap: '#FFDADA', ink: '#4a0b0b' },
  teal: { token: 'teal', face: ['#8FE8DD', '#5FD6C8'], fold: '#1F9E8F', flap: '#D6F7F3', ink: '#063a34' },
  gray: { token: 'gray', face: ['#DADDE3', '#BFC4CC'], fold: '#858C97', flap: '#F0F2F5', ink: '#1f2329' },
};

/** The palette entry for a stored token; an unknown or missing one is the default. */
export function noteColor(token: unknown): NoteColor {
  return NOTE_PALETTE[
    (NOTE_COLOR_TOKENS as readonly unknown[]).includes(token) ? (token as NoteColorToken) : DEFAULT_NOTE_COLOR
  ];
}

/** A note's paper as a style: its face gradient, text in its ink. */
export function notePaperStyle(c: NoteColor): { background: string; color: string } {
  return { background: `linear-gradient(${c.face[0]}, ${c.face[1]})`, color: c.ink };
}
