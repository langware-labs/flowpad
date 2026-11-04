/**
 * The `architecture` chart format — architecture.json (chartit.architecture): services, stores and
 * clients drawn where they run. Groups are the outer boxes (where it runs: a machine, a cloud, a
 * tenant), left to right; tiers are dashed boxes stacked inside a group; parts sit in a grid inside a
 * tier, each a role icon with its name. Links join parts, tiers or groups; a part may carry a step
 * number from the chart's numbered walk-through.
 *
 * Pure: parse, lay out on a fixed grid (no measuring, no ELK), and write the Mermaid copy.
 */

/** Each role's glyph; its fill is the role's token in chartTheme (`ARCH_ROLE_COLORS`). */
export const ARCH_ROLE_ICON = {
  client: 'lucide.app-window',
  service: 'lucide.server',
  db: 'lucide.database',
  files: 'lucide.folder',
  worker: 'lucide.cog',
  external: 'lucide.cloud',
} as const;
export type ArchRole = keyof typeof ARCH_ROLE_ICON;

export interface ArchPart {
  id: string;
  label: string;
  sublabel?: string;
  role: ArchRole;
  step?: number;
  /** Another chart's name: the part opens it (Open ↗). */
  ref?: string;
  note?: string;
}
export interface ArchTier {
  id: string;
  label: string;
  parts: ArchPart[];
  /** Columns in the tier's grid; default: all parts in one row, up to 4. */
  cols?: number;
}
export interface ArchGroup {
  id: string;
  label: string;
  sublabel?: string;
  tiers: ArchTier[];
}
export interface ArchLink {
  id: string;
  from: string;
  to: string;
  label?: string;
  style?: 'solid' | 'dashed';
  both?: boolean;
  note?: string;
}
export interface ArchStep {
  n: number;
  text: string;
}
export interface ArchValue {
  title?: string;
  groups: ArchGroup[];
  links: ArchLink[];
  steps: ArchStep[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];

function parsePart(p: Record<string, unknown>, i: number): ArchPart {
  const role = typeof p.role === 'string' && p.role in ARCH_ROLE_ICON ? (p.role as ArchRole) : 'service';
  return {
    id: str(p.id) || `part${i + 1}`,
    label: str(p.label) || str(p.id) || '?',
    sublabel: str(p.sublabel) || undefined,
    role,
    step: typeof p.step === 'number' ? p.step : undefined,
    ref: str(p.ref) || undefined,
    note: str(p.note) || undefined,
  };
}

/** A group's tiers; a group listing `parts` directly is one untitled tier, one column unless it says `cols`. */
function tiersOf(g: Record<string, unknown>, id: string): Record<string, unknown>[] {
  if (arr(g.tiers).length) return arr(g.tiers);
  if (!arr(g.parts).length) return [];
  return [{ id: `${id}-parts`, label: '', parts: g.parts, cols: typeof g.cols === 'number' ? g.cols : 1 }];
}

/** Never throws: a broken file draws as an empty chart, and the view says what failed to load. */
export function parseArchitecture(raw: string | null | undefined): ArchValue {
  let data: Record<string, unknown> = {};
  if (raw && raw.trim()) {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  }
  let n = 0;
  const groups = arr(data.groups).map((g, gi) => {
    const id = str(g.id) || `group${gi + 1}`;
    const tiers = tiersOf(g, id);
    return {
      id,
      label: str(g.label) || id,
      sublabel: str(g.sublabel) || undefined,
      tiers: tiers.map((t, ti) => ({
        id: str(t.id) || `${id}-tier${ti + 1}`,
        label: str(t.label),
        cols: typeof t.cols === 'number' && t.cols > 0 ? Math.floor(t.cols) : undefined,
        parts: arr(t.parts).map((p) => parsePart(p, n++)),
      })),
    };
  });
  const links = arr(data.links)
    .map((l, i) => ({
      id: str(l.id) || `link${i + 1}`,
      from: str(l.from),
      to: str(l.to),
      label: str(l.label) || undefined,
      style: l.style === 'dashed' ? ('dashed' as const) : ('solid' as const),
      both: l.both === true,
      note: str(l.note) || undefined,
    }))
    .filter((l) => l.from && l.to);
  const steps = arr(data.steps)
    .filter((s) => typeof s.n === 'number')
    .map((s) => ({ n: s.n as number, text: str(s.text) }))
    .sort((a, b) => a.n - b.n);
  return { title: str(data.title) || undefined, groups, links, steps };
}

// ---- layout -------------------------------------------------------------------------------------

export const ARCH = {
  CELL_W: 120, // one part's column
  CELL_H: 104, // icon + two label lines
  ICON: 44,
  TIER_PAD: 14,
  TIER_HEAD: 26,
  GROUP_PAD: 16,
  GROUP_HEAD: 44,
  GROUP_GAP: 70,
  TIER_GAP: 16,
  MARGIN: 24,
};

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PlacedPart extends Box {
  part: ArchPart;
  /** The icon square — what links attach to. */
  icon: Box;
}
export interface PlacedTier extends Box {
  tier: ArchTier;
}
export interface PlacedGroup extends Box {
  group: ArchGroup;
}
export interface PlacedLink {
  link: ArchLink;
  d: string;
  lx: number;
  ly: number;
}
export interface ArchLayout {
  width: number;
  height: number;
  groups: PlacedGroup[];
  tiers: PlacedTier[];
  parts: PlacedPart[];
  links: PlacedLink[];
  /** Any id (part, tier, group) → its box; links attach to it. */
  boxOf: Map<string, Box>;
  /** Link id → its placed link (hover looks it up). */
  linkOf: Map<string, PlacedLink>;
}

/** A tier's grid: columns, the head above it, and its size. */
function tierGrid(t: ArchTier) {
  const { CELL_W, CELL_H, TIER_PAD, TIER_HEAD } = ARCH;
  const cols = Math.max(1, t.cols ?? Math.min(Math.max(t.parts.length, 1), 4));
  const rows = Math.max(1, Math.ceil(t.parts.length / cols));
  const head = t.label ? TIER_HEAD : 10;
  return { cols, head, w: cols * CELL_W + 2 * TIER_PAD, h: head + rows * CELL_H + 6 };
}

export function layoutArchitecture(v: ArchValue): ArchLayout {
  const { CELL_W, CELL_H, ICON, GROUP_PAD, GROUP_HEAD, GROUP_GAP, TIER_GAP, MARGIN } = ARCH;
  const groupInnerW = v.groups.map((g) => Math.max(160, ...g.tiers.map((t) => tierGrid(t).w)));
  const groupH = v.groups.map(
    (g) => GROUP_HEAD + g.tiers.reduce((h, t) => h + tierGrid(t).h, 0) + Math.max(0, g.tiers.length - 1) * TIER_GAP + GROUP_PAD,
  );
  const H = Math.max(120, ...groupH);

  const groups: PlacedGroup[] = [];
  const tiers: PlacedTier[] = [];
  const parts: PlacedPart[] = [];
  const boxOf = new Map<string, Box>();
  let x = MARGIN;
  v.groups.forEach((g, gi) => {
    const w = groupInnerW[gi] + 2 * GROUP_PAD;
    const gb = { x, y: MARGIN, w, h: H };
    groups.push({ group: g, ...gb });
    boxOf.set(g.id, gb);
    // Tiers share the group's spare height, so their bottoms line up with the group's.
    const spare = g.tiers.length ? (H - groupH[gi]) / g.tiers.length : 0;
    let ty = MARGIN + GROUP_HEAD;
    g.tiers.forEach((t) => {
      const { cols, head, h } = tierGrid(t);
      const tb = { x: x + GROUP_PAD, y: ty, w: groupInnerW[gi], h: h + spare };
      tiers.push({ tier: t, ...tb });
      boxOf.set(t.id, tb);
      const x0 = tb.x + (tb.w - cols * CELL_W) / 2;
      t.parts.forEach((p, i) => {
        const px = x0 + (i % cols) * CELL_W;
        const py = ty + head + Math.floor(i / cols) * CELL_H;
        const icon = { x: px + (CELL_W - ICON) / 2, y: py + 6, w: ICON, h: ICON };
        parts.push({ part: p, x: px, y: py, w: CELL_W, h: CELL_H, icon });
        boxOf.set(p.id, icon);
      });
      ty += tb.h + TIER_GAP;
    });
    x += w + GROUP_GAP;
  });
  const width = Math.max(x - GROUP_GAP + MARGIN, 200);
  const height = H + 2 * MARGIN;

  const links: PlacedLink[] = [];
  const lanesUsed = new Map<string, number>();
  for (const link of v.links) {
    const a = boxOf.get(link.from);
    const b = boxOf.get(link.to);
    if (!a || !b) continue;
    const lane = lanesUsed.get(link.from) ?? 0;
    if (a.w > ICON || b.w > ICON) lanesUsed.set(link.from, lane + 1);
    links.push({ link, ...route(a, b, lane) });
  }
  return { width, height, groups, tiers, parts, links, boxOf, linkOf: new Map(links.map((l) => [l.link.id, l])) };
}

/**
 * One orthogonal path between two boxes: side to side when they sit apart left/right, else top to bottom.
 * Top to bottom between boxes wider than a part (tiers, groups) runs in their side padding — lane 0 on
 * the left, lane 1 on the right — so it never crosses the parts drawn inside them.
 */
function route(a: Box, b: Box, lane = 0): { d: string; lx: number; ly: number } {
  const apartX = a.x + a.w <= b.x || b.x + b.w <= a.x;
  if (apartX) {
    const leftToRight = a.x + a.w <= b.x;
    const x1 = leftToRight ? a.x + a.w : a.x;
    const x2 = leftToRight ? b.x : b.x + b.w;
    const y1 = a.y + a.h / 2;
    const y2 = b.y + b.h / 2;
    const mx = (x1 + x2) / 2;
    if (Math.abs(y1 - y2) < 1) return { d: `M${x1},${y1} H${x2}`, lx: mx, ly: y1 - 8 };
    return { d: `M${x1},${y1} H${mx} V${y2} H${x2}`, lx: mx, ly: (y1 + y2) / 2 };
  }
  const down = a.y + a.h <= b.y;
  const y1 = down ? a.y + a.h : a.y;
  const y2 = down ? b.y : b.y + b.h;
  if (a.w > ARCH.ICON || b.w > ARCH.ICON) {
    const left = Math.max(a.x, b.x);
    const right = Math.min(a.x + a.w, b.x + b.w);
    const x = lane % 2 === 0 ? left + ARCH.TIER_PAD / 2 : right - ARCH.TIER_PAD / 2;
    return { d: `M${x},${y1} V${y2}`, lx: x, ly: (y1 + y2) / 2 };
  }
  const x1 = a.x + a.w / 2;
  const x2 = b.x + b.w / 2;
  const my = (y1 + y2) / 2;
  if (Math.abs(x1 - x2) < 1) return { d: `M${x1},${y1} V${y2}`, lx: x1 + 8, ly: my };
  return { d: `M${x1},${y1} V${my} H${x2} V${y2}`, lx: (x1 + x2) / 2, ly: my - 6 };
}

// ---- text forms ---------------------------------------------------------------------------------

const mmText = (s: string) => s.replace(/"/g, '#quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mmId = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');

/** The Mermaid copy kept in CHART.md: subgraphs for groups and tiers, a node per part. */
export function architectureToMermaid(v: ArchValue): string {
  const lines = ['flowchart LR'];
  for (const g of v.groups) {
    lines.push(`  subgraph ${mmId(g.id)}["${mmText(g.label)}"]`);
    for (const t of g.tiers) {
      const inner = t.label ? '    ' : '  ';
      if (t.label) lines.push(`    subgraph ${mmId(t.id)}["${mmText(t.label)}"]`);
      for (const p of t.parts) {
        const text = `"${p.step ? `${p.step}. ` : ''}${mmText(p.label)}${p.sublabel ? `<br/>${mmText(p.sublabel)}` : ''}"`;
        lines.push(`${inner}  ${mmId(p.id)}${p.role === 'db' || p.role === 'files' ? `[(${text})]` : `[${text}]`}`);
      }
      if (t.label) lines.push('    end');
    }
    lines.push('  end');
  }
  for (const l of v.links) {
    const arrow = l.style === 'dashed' ? (l.both ? '<-.->' : '-.->') : l.both ? '<-->' : '-->';
    lines.push(`  ${mmId(l.from)} ${arrow}${l.label ? `|"${mmText(l.label)}"|` : ''} ${mmId(l.to)}`);
  }
  return lines.join('\n');
}

/** Where a part sits, for the table: "Group › Tier". */
export function partPlaces(v: ArchValue): Map<string, string> {
  const map = new Map<string, string>();
  for (const g of v.groups) for (const t of g.tiers) for (const p of t.parts) map.set(p.id, [g.label, t.label].filter(Boolean).join(' › '));
  return map;
}

/** Any id → its display name (part, tier, group). */
export function namesOf(v: ArchValue): Map<string, string> {
  const map = new Map<string, string>();
  for (const g of v.groups) {
    map.set(g.id, g.label);
    for (const t of g.tiers) {
      map.set(t.id, t.label || g.label);
      for (const p of t.parts) map.set(p.id, p.label);
    }
  }
  return map;
}
