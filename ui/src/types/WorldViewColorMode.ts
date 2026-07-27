export const WORLDVIEW_COLOR_MODES = ['type', 'footprint', 'cost', 'activity'] as const;

export type WorldViewColorMode = (typeof WORLDVIEW_COLOR_MODES)[number];

export const DEFAULT_WORLDVIEW_COLOR_MODE: WorldViewColorMode = 'type';

export function isWorldViewColorMode(value: unknown): value is WorldViewColorMode {
  return typeof value === 'string' && WORLDVIEW_COLOR_MODES.some((mode) => mode === value);
}
