import { WILDCARD_ROLE } from '@sdk';

/**
 * What makes a role edge worth annotating on the graph.
 *
 * Every containment edge starts as `('*','*')` — a pass-through conferring
 * whatever the holder already had. That is most edges, so only two shapes earn a
 * badge: containment that is no longer pass-through, and any edge matching on a
 * SPECIFIC source role (a plain grant is always `* -> <role>`, so a named source
 * only ever comes from a rule someone wrote — which is how an override's extra
 * rules, carried on ordinary role edges, still get labelled).
 */
export { WILDCARD_ROLE };

export function isOverrideMapping(
  fromRole: string | null | undefined,
  kind: string | null | undefined,
  topology?: string | null,
): boolean {
  if (!fromRole) return false; // no mapping reported — nothing to say
  if (fromRole !== WILDCARD_ROLE) return true; // a named source role is a written rule
  return topology === 'hierarchy' && kind !== WILDCARD_ROLE;
}

/** The badge an annotated edge carries, e.g. `admin → member`. */
export function mappingLabel(fromRole: string, kind: string): string {
  return `${fromRole} → ${kind}`;
}
