import type Graph from 'graphology';
import {
  DEFAULT_WORLDVIEW_COLOR_MODE,
  type WorldViewColorMode,
} from '@src/types/WorldViewColorMode';
import type { EdgeKind } from './themeColors';

export const UNKNOWN_HEAT_COLOR = '#64748b';
export const COLD_HEAT_COLOR = '#2563eb';
export const HOT_HEAT_COLOR = '#ef4444';

const HEAT_ATTRIBUTE = 'worldViewHeat';
const HEAT_SUMMARIES_ATTRIBUTE = 'worldViewHeatSummaries';
const CHILD_EDGE_KIND = 'child' satisfies EdgeKind;

type ObservationMode = 'cost' | 'activity';
type HeatCoverage = 'available' | 'unavailable' | 'unattributed' | 'stale';

export type WorldViewHeatValue = Readonly<{
  value: number | null;
  normalized: number | null;
  color: string;
  coverage: HeatCoverage;
  cohort: string | null;
  metric: string | null;
  unit: string | null;
}>;

export type WorldViewNodeHeat = Readonly<Record<Exclude<WorldViewColorMode, 'type'>, WorldViewHeatValue>>;

export type WorldViewHeatSummary = Readonly<{
  mode: WorldViewColorMode;
  signal: string;
  known: number;
  unknown: number;
  total: number;
  stale: number;
  cohorts: number;
  low: number | null;
  high: number | null;
}>;

type HeatSummaries = Readonly<Record<WorldViewColorMode, WorldViewHeatSummary>>;

type PendingHeatValue = {
  value: number | null;
  normalized: number | null;
  color: string;
  coverage: HeatCoverage;
  cohort: string | null;
  metric: string | null;
  unit: string | null;
};

const PALETTE_STOPS = [
  { at: 0, color: COLD_HEAT_COLOR },
  { at: 0.4, color: '#22d3ee' },
  { at: 0.7, color: '#facc15' },
  { at: 1, color: HOT_HEAT_COLOR },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Normalize comparable values without letting one very large resource flatten
 * the rest of the scale. Non-negative signals use log1p; quartile fences then
 * winsorize outliers before mapping to 0..1.
 */
export function normalizeHeatValues(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const useLog = values.every((value) => value >= 0);
  const transformed = values.map((value) => (useLog ? Math.log1p(value) : value));
  const sorted = [...transformed].sort((left, right) => left - right);
  const minimum = sorted[0];
  const maximum = sorted[sorted.length - 1];

  let low = minimum;
  let high = maximum;
  if (sorted.length >= 4) {
    const lowerQuartile = percentile(sorted, 0.25);
    const upperQuartile = percentile(sorted, 0.75);
    const spread = upperQuartile - lowerQuartile;
    if (spread > 0) {
      low = Math.max(minimum, lowerQuartile - spread * 1.5);
      high = Math.min(maximum, upperQuartile + spread * 1.5);
    }
  }

  if (high <= low) return transformed.map(() => 0.5);
  return transformed.map((value) => Math.max(0, Math.min(1, (value - low) / (high - low))));
}

function rgb(color: string): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function hex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Return the stable cold-to-hot color for a normalized value. */
export function heatColor(normalized: number): string {
  const value = Math.max(0, Math.min(1, normalized));
  const upperIndex = PALETTE_STOPS.findIndex((stop) => value <= stop.at);
  if (upperIndex <= 0) return PALETTE_STOPS[0].color;
  const lower = PALETTE_STOPS[upperIndex - 1];
  const upper = PALETTE_STOPS[upperIndex];
  const amount = (value - lower.at) / (upper.at - lower.at);
  const from = rgb(lower.color);
  const to = rgb(upper.color);
  return hex(
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  );
}

/**
 * Inclusive recursive hierarchy size for every node. Only outbound `child`
 * edges participate; deployment links and other graph relationships do not.
 */
export function childFootprints(graph: Graph): Map<string, number> {
  const footprints = new Map<string, number>();
  graph.forEachNode((root) => {
    const visited = new Set<string>([root]);
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop()!;
      graph.forEachOutEdge(current, (_edge, attributes, _source, target) => {
        if (attributes.kind !== CHILD_EDGE_KIND || visited.has(target)) return;
        visited.add(target);
        pending.push(target);
      });
    }
    footprints.set(root, visited.size);
  });
  return footprints;
}

function unknownHeatValue(coverage: HeatCoverage = 'unavailable'): PendingHeatValue {
  return {
    value: null,
    normalized: null,
    color: UNKNOWN_HEAT_COLOR,
    coverage,
    cohort: null,
    metric: null,
    unit: null,
  };
}

function observationHeatValue(attributes: Record<string, unknown>, mode: ObservationMode): PendingHeatValue {
  const properties = isRecord(attributes.properties) ? attributes.properties : {};
  const observations = isRecord(properties.observations) ? properties.observations : {};
  const observation = isRecord(observations[mode]) ? observations[mode] : null;
  if (!observation) return unknownHeatValue();

  const coverageValue = observation.coverage;
  const coverage: HeatCoverage =
    coverageValue === 'available' ||
    coverageValue === 'unavailable' ||
    coverageValue === 'unattributed' ||
    coverageValue === 'stale'
      ? coverageValue
      : 'unavailable';
  const metric = typeof observation.metric === 'string' && observation.metric.trim()
    ? observation.metric.trim()
    : null;
  const unit = typeof observation.unit === 'string' && observation.unit.trim()
    ? observation.unit.trim()
    : null;
  const value = coverage === 'available' || coverage === 'stale' ? finiteNumber(observation.value) : null;
  if (value === null || metric === null) {
    return { ...unknownHeatValue(coverage), metric, unit };
  }

  const windowStart = typeof observation.window_start === 'string' ? observation.window_start : '';
  const windowEnd = typeof observation.window_end === 'string' ? observation.window_end : '';
  return {
    value,
    normalized: null,
    color: UNKNOWN_HEAT_COLOR,
    coverage,
    cohort: [metric, unit ?? '', windowStart, windowEnd].join('\u001f'),
    metric,
    unit,
  };
}

function applyCohortColors(values: Map<string, PendingHeatValue>): void {
  const cohorts = new Map<string, PendingHeatValue[]>();
  for (const heat of values.values()) {
    if (heat.value === null || heat.cohort === null) continue;
    const cohort = cohorts.get(heat.cohort) ?? [];
    cohort.push(heat);
    cohorts.set(heat.cohort, cohort);
  }
  for (const cohort of cohorts.values()) {
    const normalized = normalizeHeatValues(cohort.map((heat) => heat.value!));
    cohort.forEach((heat, index) => {
      heat.normalized = normalized[index];
      heat.color = heatColor(normalized[index]);
    });
  }
}

function summary(
  mode: WorldViewColorMode,
  signal: string,
  values: Iterable<PendingHeatValue>,
  total: number,
): WorldViewHeatSummary {
  const knownValues: number[] = [];
  const cohorts = new Set<string>();
  let stale = 0;
  let low = Infinity;
  let high = -Infinity;
  for (const heat of values) {
    if (heat.value === null) continue;
    knownValues.push(heat.value);
    low = Math.min(low, heat.value);
    high = Math.max(high, heat.value);
    if (heat.cohort) cohorts.add(heat.cohort);
    if (heat.coverage === 'stale') stale += 1;
  }
  return Object.freeze({
    mode,
    signal,
    known: knownValues.length,
    unknown: total - knownValues.length,
    total,
    stale,
    cohorts: cohorts.size,
    low: knownValues.length > 0 && cohorts.size <= 1 ? low : null,
    high: knownValues.length > 0 && cohorts.size <= 1 ? high : null,
  });
}

/**
 * Attach immutable, presentation-ready heat values to a WorldView graph. This
 * is deliberately provider-neutral: absent normalized observations stay gray.
 */
export function annotateWorldViewHeat(graph: Graph): HeatSummaries {
  const footprints = childFootprints(graph);
  const footprintValues = new Map<string, PendingHeatValue>();
  const costValues = new Map<string, PendingHeatValue>();
  const activityValues = new Map<string, PendingHeatValue>();

  graph.forEachNode((node, attributes) => {
    footprintValues.set(node, {
      value: footprints.get(node) ?? 1,
      normalized: null,
      color: UNKNOWN_HEAT_COLOR,
      coverage: 'available',
      cohort: 'footprint\u001fresources',
      metric: 'footprint.child_hierarchy',
      unit: 'resources',
    });
    costValues.set(node, observationHeatValue(attributes, 'cost'));
    activityValues.set(node, observationHeatValue(attributes, 'activity'));
  });

  applyCohortColors(footprintValues);
  applyCohortColors(costValues);
  applyCohortColors(activityValues);

  graph.forEachNode((node) => {
    const heat = Object.freeze({
      footprint: Object.freeze({ ...footprintValues.get(node)! }),
      cost: Object.freeze({ ...costValues.get(node)! }),
      activity: Object.freeze({ ...activityValues.get(node)! }),
    });
    graph.setNodeAttribute(node, HEAT_ATTRIBUTE, heat);
  });

  const total = graph.order;
  const summaries: HeatSummaries = Object.freeze({
    type: Object.freeze({
      mode: DEFAULT_WORLDVIEW_COLOR_MODE,
      signal: 'Entity type',
      known: total,
      unknown: 0,
      total,
      stale: 0,
      cohorts: total > 0 ? 1 : 0,
      low: null,
      high: null,
    }),
    footprint: summary('footprint', 'Hierarchy footprint', footprintValues.values(), total),
    cost: summary('cost', 'Net cost observation', costValues.values(), total),
    activity: summary('activity', 'Runtime activity observation', activityValues.values(), total),
  });
  graph.setAttribute(HEAT_SUMMARIES_ATTRIBUTE, summaries);
  return summaries;
}

export function heatSummaryForGraph(graph: Graph, mode: WorldViewColorMode): WorldViewHeatSummary {
  const stored = graph.hasAttribute(HEAT_SUMMARIES_ATTRIBUTE)
    ? (graph.getAttribute(HEAT_SUMMARIES_ATTRIBUTE) as HeatSummaries)
    : null;
  if (stored?.[mode]) return stored[mode];
  const known = mode === 'type' ? graph.order : 0;
  return Object.freeze({
    mode,
    signal:
      mode === 'type'
        ? 'Entity type'
        : mode === 'footprint'
          ? 'Hierarchy footprint'
          : mode === 'cost'
            ? 'Net cost observation'
            : 'Runtime activity observation',
    known,
    unknown: graph.order - known,
    total: graph.order,
    stale: 0,
    cohorts: known > 0 ? 1 : 0,
    low: null,
    high: null,
  });
}

export function colorForWorldViewMode(
  attributes: Record<string, unknown>,
  mode: WorldViewColorMode,
): string | null {
  if (mode === 'type') return typeof attributes.color === 'string' ? attributes.color : null;
  const heat = isRecord(attributes[HEAT_ATTRIBUTE]) ? attributes[HEAT_ATTRIBUTE] : null;
  const value = heat && isRecord(heat[mode]) ? heat[mode] : null;
  return value && typeof value.color === 'string' ? value.color : UNKNOWN_HEAT_COLOR;
}
