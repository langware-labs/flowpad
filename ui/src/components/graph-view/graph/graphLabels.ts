import type { NodeLabelDrawingFunction } from 'sigma/rendering';
import type { GraphPalette } from './themeColors';

const ELLIPSIS = '…';
const UUID_PATTERN = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HEX_PATTERN = /\b([0-9a-f]{10})[0-9a-f]{10,}([0-9a-f]{6})\b/gi;

type LabelDrawArgs = Parameters<NodeLabelDrawingFunction>;

function decodeDisplaySegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function middleEllipsis(value: string, maximumCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maximumCharacters) return value;
  const available = Math.max(1, maximumCharacters - 1);
  const head = Math.ceil(available * 0.7);
  const tail = available - head;
  return `${characters.slice(0, head).join('')}${ELLIPSIS}${tail ? characters.slice(-tail).join('') : ''}`;
}

/** Compact a graph label for the canvas without changing its source value. */
export function compactGraphLabel(value: string, maximumCharacters = 40): string {
  const source = String(value ?? '').trim();
  if (!source) return source;

  let display = source;
  const path = source.split(/[\\/]/).filter(Boolean);
  if (path.length > 1 && Array.from(source).length > maximumCharacters) {
    const leaf = decodeDisplaySegment(path.at(-1) ?? source);
    const owner = path.length >= 3 ? decodeDisplaySegment(path.at(-3) ?? '') : '';
    display = /^\d+$/.test(leaf) && owner ? `${owner} · ${leaf}` : leaf;
  }

  display = display.replace(UUID_PATTERN, '$1…');
  display = display.replace(LONG_HEX_PATTERN, '$1…$2');
  return middleEllipsis(display, maximumCharacters);
}

/** Ellipsize against actual canvas text metrics, preserving both ends. */
export function fitLabelToWidth(value: string, measure: (candidate: string) => number, maximumWidth: number): string {
  if (!value || measure(value) <= maximumWidth) return value;
  const characters = Array.from(value);
  if (measure(ELLIPSIS) > maximumWidth) return '';

  let low = 0;
  let high = characters.length;
  let best = ELLIPSIS;
  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const head = Math.ceil(kept * 0.7);
    const tail = kept - head;
    const candidate = `${characters.slice(0, head).join('')}${ELLIPSIS}${tail ? characters.slice(-tail).join('') : ''}`;
    if (measure(candidate) <= maximumWidth) {
      best = candidate;
      low = kept + 1;
    } else {
      high = kept - 1;
    }
  }
  return best;
}

function textColor(data: LabelDrawArgs[1], settings: LabelDrawArgs[2], fallback: string): string {
  const attribute = settings.labelColor.attribute;
  // `color` is optional on sigma's attribute-driven variant, and an undefined
  // fillStyle silently keeps the previous colour — same `|| fallback` the
  // attribute branch below already applies.
  if (!attribute) return settings.labelColor.color || fallback;
  const value = (data as Record<string, unknown>)[attribute];
  return typeof value === 'string' ? value : settings.labelColor.color || fallback;
}

function drawLabel(
  context: LabelDrawArgs[0],
  data: LabelDrawArgs[1],
  settings: LabelDrawArgs[2],
  palette: GraphPalette,
  maximumWidth: number,
  background: string,
): void {
  if (!data.label) return;
  const size = settings.labelSize;
  context.save();
  context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
  const label = fitLabelToWidth(data.label, (candidate) => context.measureText(candidate).width, maximumWidth);
  if (!label) {
    context.restore();
    return;
  }

  const width = context.measureText(label).width;
  const x = data.x + data.size + 5;
  const baseline = data.y + size / 3;
  context.fillStyle = background;
  context.fillRect(x - 3, baseline - size - 2, width + 6, size + 5);
  context.fillStyle = textColor(data, settings, palette.labelColor);
  context.fillText(label, x, baseline);
  context.restore();
}

export function drawGraphNodeLabel(
  context: LabelDrawArgs[0],
  data: LabelDrawArgs[1],
  settings: LabelDrawArgs[2],
  palette: GraphPalette,
): void {
  drawLabel(context, data, settings, palette, 180, palette.labelBackground);
}

export function drawGraphNodeHover(
  context: LabelDrawArgs[0],
  data: LabelDrawArgs[1],
  settings: LabelDrawArgs[2],
  palette: GraphPalette,
): void {
  drawLabel(context, data, settings, palette, 300, palette.hoverLabelBackground);
}
