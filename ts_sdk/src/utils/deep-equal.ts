const MAX_DEPTH = 32;

/**
 * Deep-equal for primitives, Dates, arrays, and plain objects (own enumerable keys). Deeper than
 * {@link MAX_DEPTH} (a cycle, a graph) answers false: "not known equal".
 */
export function deepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (depth > MAX_DEPTH) return false;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i], depth + 1));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
    for (const k of keys) {
      if (!deepEqual(aObj[k], bObj[k], depth + 1)) return false;
    }
    return true;
  }
  return false;
}
