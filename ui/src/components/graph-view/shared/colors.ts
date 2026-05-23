// Neural-themed color palette
export const COMMUNITY_COLORS = [
  '#00f5ff', // cyan
  '#ff006e', // magenta
  '#8338ec', // purple
  '#ff9500', // orange
  '#00e676', // green
  '#ffea00', // yellow
  '#2979ff', // blue
  '#ff1744', // red
  '#76ff03', // lime
  '#e040fb', // pink
  '#00bcd4', // teal
  '#ff6d00', // deep orange
  '#651fff', // deep purple
  '#1de9b6', // mint
  '#ffd600', // amber
];

export const PULSE_COLORS = [
  '#00f5ff',
  '#ff006e',
  '#8338ec',
  '#ff9500',
  '#00e676',
  '#ffea00',
  '#2979ff',
  '#ff1744',
  '#76ff03',
  '#e040fb',
];

export const BG_COLOR = '#0a0a1a';
export const EDGE_DEFAULT_COLOR = 'rgba(255,255,255,0.06)';
export const EDGE_ACTIVE_COLOR = 'rgba(255,255,255,0.15)';
export const NODE_DEFAULT_OPACITY = 0.85;
export const NODE_HOVER_GLOW = '#ffffff';

export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function lighten(hex: string, amount: number): string {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + amount);
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + amount);
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + amount);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
