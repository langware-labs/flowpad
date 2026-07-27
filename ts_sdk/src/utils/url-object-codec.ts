/**
 * Generic serialize/deserialize of a NAMED object to/from flat URL-param options,
 * using the `<ns>-<field>=value` grammar (e.g. `scope-mode=project`).
 *
 * This is the single mechanism for stashing a small structured object inside a
 * dock URL's query options. Each object type reserves ONE namespace slot (a
 * reserved word, e.g. `scope`) and supplies field-level encode/decode; the
 * namespacing, collection-by-prefix, and replace-merge mechanics all live here
 * once. Scope is the first consumer (`SCOPE_CODEC`); side-windows and any future
 * URL-carried object register the same way.
 *
 * Why a prefix instead of bare keys: a dock's `options` is a flat
 * `Record<string,string>` shared by several concerns. Namespacing keeps them
 * collision-free and self-describing — every `scope-*` key provably belongs to
 * the scope object, so we collect/replace by prefix rather than an allowlist.
 */

const SEP = '-';

export interface UrlObjectCodec<T> {
  /** Reserved namespace slot, e.g. `scope`. Prefixes every field as `${ns}-${field}`. */
  readonly ns: string;
  /** Object → bare field map (field names WITHOUT the `${ns}-` prefix). */
  encode(value: T): Record<string, string>;
  /** Bare field map → object, or null when the fields don't form a valid value. */
  decode(fields: Record<string, string>): T | null;
}

const registry = new Map<string, UrlObjectCodec<unknown>>();

/**
 * Reserve a namespace slot for a codec. The namespace is a reserved word: a
 * second, different codec claiming the same slot throws (mis-wired duplicate).
 * Re-registering the same codec instance is a no-op. Returns the codec so it can
 * be defined and registered in one expression.
 */
export function registerUrlObject<T>(codec: UrlObjectCodec<T>): UrlObjectCodec<T> {
  if (!codec.ns || codec.ns.includes(SEP)) {
    throw new Error(`URL-object namespace must be non-empty and contain no '${SEP}': '${codec.ns}'`);
  }
  const existing = registry.get(codec.ns);
  if (existing && existing !== (codec as unknown as UrlObjectCodec<unknown>)) {
    throw new Error(`URL-object namespace '${codec.ns}' is already reserved`);
  }
  registry.set(codec.ns, codec as unknown as UrlObjectCodec<unknown>);
  return codec;
}

/** Object → namespaced params, e.g. `{ 'scope-mode': 'project', 'scope-activeProjectId': '…' }`. */
export function encodeUrlObject<T>(codec: UrlObjectCodec<T>, value: T): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, raw] of Object.entries(codec.encode(value))) {
    out[`${codec.ns}${SEP}${field}`] = raw;
  }
  return out;
}

/** Namespaced params → object, or null when no `${ns}-` key is present at all. */
export function decodeUrlObject<T>(
  codec: UrlObjectCodec<T>,
  options: Record<string, string> | undefined,
): T | null {
  if (!options) return null;
  const prefix = `${codec.ns}${SEP}`;
  const fields: Record<string, string> = {};
  let present = false;
  for (const [key, value] of Object.entries(options)) {
    if (key.startsWith(prefix)) {
      fields[key.slice(prefix.length)] = value;
      present = true;
    }
  }
  return present ? codec.decode(fields) : null;
}

/**
 * Drop every param in this codec's namespace, leaving other namespaces intact —
 * the "no value at all" counterpart to {@link mergeUrlObject}. Needed because an
 * object can be *unsatisfiable* (a scope pinned to a project that no longer
 * exists), and the honest URL for that is one carrying no such object, not one
 * carrying a half-erased shell of it.
 */
export function clearUrlObject<T>(
  codec: UrlObjectCodec<T>,
  options: Record<string, string> | undefined,
): Record<string, string> {
  const prefix = `${codec.ns}${SEP}`;
  const next: Record<string, string> = {};
  for (const [key, v] of Object.entries(options ?? {})) {
    if (!key.startsWith(prefix)) next[key] = v;
  }
  return next;
}

/**
 * Merge `value`'s namespaced params into `options`, REPLACING any prior keys in
 * this codec's namespace so stale fields can't linger and shadow the new value.
 * Keys in other namespaces pass through untouched.
 */
export function mergeUrlObject<T>(
  codec: UrlObjectCodec<T>,
  options: Record<string, string> | undefined,
  value: T,
): Record<string, string> {
  return { ...clearUrlObject(codec, options), ...encodeUrlObject(codec, value) };
}
