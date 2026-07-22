/**
 * Shared dot-taxonomy grammar — THE single owner of topic string rules.
 *
 * One grammar serves every dot-separated vocabulary in the system: bus topics
 * (`flow.step.done`), subscription patterns (`flow.*`), and the kind ontology
 * (`application.web` — see models/Kind.ts, now a shim over this module).
 * Python twin: `flow_sdk/topics/grammar.py`; parity is pinned by the
 * `grammar` section of `tests/fixtures/flow_event_contract.json`.
 *
 * Two match semantics, deliberately named apart and never merged:
 * - `topicMatches(pattern, topic)` — SUBSCRIPTION glob. `*` matches exactly
 *   one segment; a trailing `*` matches any remaining suffix.
 * - `topicIsWithin(topic, prefix)` — HIERARCHY prefix (exact-or-descendant):
 *   `workload` contains `workload.service.http`. Lenient (trim+lower, never
 *   throws) so capability matchers can call it on untrusted strings.
 *
 * Namespaces: a user-world topic starts with a `--<ns>--` segment
 * (`--acme--.orders.created`). The marker is legal ONLY as the first segment.
 */

// Same segment character class as the legacy KIND_PATTERN — existing kinds
// and bus topics all remain valid by construction.
export const TOPIC_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

/** A namespace marker segment: `--<ns>--` with a non-empty simple name. */
export const NAMESPACE_SEGMENT_PATTERN = /^--([a-z0-9_]+)--$/;

/** A validated topic name (branded — obtain via {@link asTopic}/{@link tryTopic}). */
export type TopicStr = string & { readonly __topic: unique symbol };

/**
 * Normalize (trim + lower) and validate a topic name. Throws on invalid.
 * The STRICT gate — used wherever a topic is adopted as data. The bus itself
 * never calls this on emit (the bus stays permissive; see EventBus.ts).
 */
export function normalizeTopic(value: string): TopicStr {
  if (typeof value !== 'string') throw new Error('topic must be a string');
  const normalized = value.trim().toLowerCase();
  if (!TOPIC_PATTERN.test(normalized)) {
    throw new Error(`Invalid topic: ${value}`);
  }
  const segments = normalized.split('.');
  for (let i = 1; i < segments.length; i++) {
    if (NAMESPACE_SEGMENT_PATTERN.test(segments[i])) {
      throw new Error('a --namespace-- marker is only legal as the first segment');
    }
  }
  return normalized as TopicStr;
}

/** Null-returning brand cast for untrusted input. */
export function tryTopic(value: unknown): TopicStr | null {
  if (typeof value !== 'string') return null;
  try {
    return normalizeTopic(value);
  } catch {
    return null;
  }
}

/** True when `value` normalizes into a valid topic name. */
export function isValidTopic(value: unknown): value is string {
  return tryTopic(value) !== null;
}

export function topicSegments(topic: string): string[] {
  return topic.split('.');
}

/**
 * Split `--acme--.orders.created` → `['acme', 'orders.created']`.
 * System topics (no marker) return `[null, topic]` unchanged.
 */
export function splitNamespace(topic: string): [string | null, string] {
  const dot = topic.indexOf('.');
  const head = dot === -1 ? topic : topic.slice(0, dot);
  const m = NAMESPACE_SEGMENT_PATTERN.exec(head);
  if (m) return [m[1], dot === -1 ? '' : topic.slice(dot + 1)];
  return [null, topic];
}

/** Dot ancestors from broadest to narrowest (strict — normalizes first). */
export function topicAncestors(topic: string, includeSelf = false): string[] {
  const segments = normalizeTopic(topic).split('.');
  const count = includeSelf ? segments.length : segments.length - 1;
  return Array.from({ length: count }, (_, index) => segments.slice(0, index + 1).join('.'));
}

// ── subscription glob (the bus semantics) ──────────────────────────────────

/** Segment-wise glob core over pre-split lists (hot path — no allocation). */
export function segmentsMatch(p: string[], t: string[]): boolean {
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*' && i === p.length - 1) return t.length >= i + 1;
    if (i >= t.length) return false;
    if (p[i] !== '*' && p[i] !== t[i]) return false;
  }
  return t.length === p.length;
}

/**
 * Segment-wise glob over the dot path. `*` matches exactly one segment; a
 * TRAILING `*` matches any remaining suffix (so `app.*` matches
 * `app.route.loaded`). No partial-segment matching — `app.rou*` is not a thing.
 */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === '*') return true;
  return segmentsMatch(pattern.split('.'), topic.split('.'));
}

/**
 * THE pattern grammar gate (TOPIC triggers, flow subscriptions): a pointed
 * problem string, or null when valid. Segments must be topic segments or `*`;
 * a bare `*` is rejected (it would fire on every event). Python twin:
 * `topic_pattern_problem`.
 */
export function topicPatternProblem(pattern: string | null | undefined): string | null {
  const stripped = (pattern ?? '').trim();
  if (!stripped) return 'a non-empty topic pattern is required';
  if (stripped === '*') {
    return (
      'pattern "*" would fire on EVERY event in the system — ' +
      'subscribe to a family (e.g. "entity.*", "flow.*") instead'
    );
  }
  const segments = stripped.split('.');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === '*') continue;
    if (!TOPIC_PATTERN.test(seg)) {
      return `segment "${seg}" is not a valid topic segment (lowercase letters, numbers, '_', '-', or '*')`;
    }
    if (NAMESPACE_SEGMENT_PATTERN.test(seg) && i !== 0) {
      return 'a --namespace-- marker is only legal as the first segment';
    }
  }
  return null;
}

export function isValidTopicPattern(pattern: string | null | undefined): boolean {
  return topicPatternProblem(pattern) === null;
}

// ── hierarchy prefix (the ontology semantics) ───────────────────────────────

/**
 * Exact-or-descendant containment: `workload` contains
 * `workload.service.http`. LENIENT — trim+lower without grammar validation,
 * never throws (capability resolution calls this on untrusted strings).
 */
export function topicIsWithin(topic: string, prefix: string): boolean {
  const t = topic.trim().toLowerCase();
  const p = prefix.trim().toLowerCase();
  return t === p || t.startsWith(`${p}.`);
}

/**
 * Derive the parent → children adjacency implied by dot-paths. Includes
 * implicit intermediate nodes; roots appear under the `''` key. Pure
 * derivation — the taxonomy graph is never stored.
 */
export function topicTree(names: string[]): Record<string, string[]> {
  const children = new Map<string, Set<string>>();
  for (const name of names) {
    const parts = name.split('.');
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('.');
      const child = parts.slice(0, i + 1).join('.');
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent)!.add(child);
    }
  }
  return Object.fromEntries(
    [...children.entries()].map(([parent, kids]) => [parent, [...kids].sort()]),
  );
}
