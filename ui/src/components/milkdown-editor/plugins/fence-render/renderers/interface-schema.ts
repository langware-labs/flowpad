/**
 * Shape of an ```interface block: an API / function-signature contract
 * authored in YAML.
 *
 *     ```interface
 *     name: createTask
 *     description: Create a task in the current project.
 *     params:
 *       title: string
 *       due: date?          # trailing ? marks the param optional
 *     returns: Task
 *     errors: [NotFound, Forbidden]
 *     ```
 *
 * Kept separate from the DOM renderer, and the zod schema kept as its own
 * exported const, because nothing outside the renderer validates these blocks
 * today. If they later need to be machine-read — indexed, checked at write
 * time, surfaced as entities — this module moves wholesale rather than being
 * rewritten out of a view.
 */

import { isSafeRelPath, normalizeFSOrigin, type FSOriginField } from '@sdk';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** A param may be declared as a bare type, or as an object with a description. */
const paramValueSchema = z.union([
  z.string(),
  z.object({
    type: z.string(),
    description: z.string().optional(),
  }),
]);

/**
 * Where the contract is grounded in code.
 *
 * `origin` is the SDK's filesystem-origin union verbatim — validated loosely
 * here and handed to `normalizeFSOrigin()` below, which owns the real shape
 * (including the "a missing `kind` means git" rule the backend discriminator
 * uses). Re-deriving that discrimination in zod would give us a second,
 * drifting definition of what an origin is.
 */
const sourceSchema = z.object({
  origin: z.record(z.string(), z.unknown()),
  line: z.number().int().positive().optional(),
});

export const interfaceSpecSchema = z.object({
  name: z.string().min(1, 'name must not be empty'),
  description: z.string().optional(),
  params: z.record(z.string(), paramValueSchema).optional(),
  returns: z.string().optional(),
  errors: z.array(z.string()).optional(),
  source: sourceSchema.optional(),
});

export type InterfaceSpecInput = z.infer<typeof interfaceSpecSchema>;

export interface InterfaceParam {
  name: string;
  type: string;
  optional: boolean;
  description?: string;
}

/** A contract's grounding in source: where the code lives, and which line. */
export interface InterfaceSource {
  origin: FSOriginField;
  line?: number;
}

/** Normalized form the renderer draws from. */
export interface InterfaceSpec {
  name: string;
  description?: string;
  params: InterfaceParam[];
  returns?: string;
  errors: string[];
  source?: InterfaceSource;
}

export const OPTIONAL_SUFFIX = '?';

/**
 * `date?` → `{ type: 'date', optional: true }`.
 *
 * Shared with `interface-edit.ts`: optionality is encoded in the same scalar as
 * the type, so the read and write paths must split it identically — otherwise a
 * type edit silently drops the marker.
 */
export function splitOptional(rawType: string): { type: string; optional: boolean } {
  const trimmed = rawType.trim();
  if (trimmed.length > 1 && trimmed.endsWith(OPTIONAL_SUFFIX)) {
    return { type: trimmed.slice(0, -1).trim(), optional: true };
  }
  return { type: trimmed, optional: false };
}

/**
 * Parse and validate an `interface` block body.
 *
 * Throws with a message naming the offending key — the NodeView surfaces it as
 * an inline chip, and the source is one tab away.
 */
export function parseInterfaceBlock(source: string): InterfaceSpec {
  if (!source.trim()) throw new Error('Empty interface block');

  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw new Error(`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('An interface block must be a YAML mapping with a `name` key');
  }

  const result = interfaceSpecSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join('.');
    throw new Error(path ? `${path}: ${issue.message}` : issue.message);
  }

  const spec = result.data;
  const params: InterfaceParam[] = Object.entries(spec.params ?? {}).map(([name, value]) => {
    const rawType = typeof value === 'string' ? value : value.type;
    const { type, optional } = splitOptional(rawType);
    return {
      name,
      type,
      optional,
      description: typeof value === 'string' ? undefined : value.description,
    };
  });

  return {
    name: spec.name,
    description: spec.description,
    params,
    returns: spec.returns,
    errors: spec.errors ?? [],
    source: spec.source ? normalizeSource(spec.source) : undefined,
  };
}

/**
 * Turn the YAML `source` mapping into a real origin.
 *
 * `normalizeFSOrigin` is the SDK's own json-boundary converter — the same one
 * the wire path uses — so a hand-authored block and a backend-persisted origin
 * are read by identical rules, including the missing-`kind`-means-git
 * tolerance. Everything here throws on bad input; the NodeView turns that into
 * the block's inline error chip.
 */
function normalizeSource(raw: { origin: Record<string, unknown>; line?: number }): InterfaceSource {
  const origin = normalizeFSOrigin(raw.origin as Parameters<typeof normalizeFSOrigin>[0]);
  if (!origin) throw new Error('source.origin: not a valid origin');

  // The same repo-relative safety rule the backend enforces. FE and BE must
  // agree on this, so use the shared predicate rather than a local check.
  if (!isSafeRelPath(origin.rel_path)) {
    throw new Error(`source.origin.rel_path: unsafe or missing path "${origin.rel_path}"`);
  }
  return { origin, line: raw.line };
}
