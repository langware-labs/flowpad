/**
 * Which glyph an activity row shows.
 *
 * An activity is not an entity type, so `iconForType` cannot answer for it directly. The
 * resolution order is producer first, then the thing the work belongs to, then a generic
 * fallback — so nothing here hardcodes a glyph per activity name, and a process activity
 * gets the process glyph without its producer duplicating the type registry:
 *
 *   1. an explicit `.icon(...)` from the producer, resolved by `lucideByName` (which takes
 *      a lucide export name OR a backend-served path, so a bespoke glyph needs no code);
 *   2. the scope entity's `TypeInfo.icon`, via the registry `iconForType` reads;
 *   3. `Activity`, the generic "something is happening" glyph.
 *
 * On the hub, step 2 degrades to step 3: the hub's bootstrap ships no `types`, so the
 * frontend SchemaRegistry is empty there. That is expected, not a bug.
 */

import { Activity as ActivityGlyph, type LucideIcon } from 'lucide-react';
import { lucideByName } from '@src/lib/lucide-by-name';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import type { ActivityProgressSpec } from '@sdk/activity';
import { TypeId, isTypeId } from '@sdk';

/**
 * `agentic_process-<uuid>` → `agentic_process`.
 *
 * Through the SDK parser, which splits on the FIRST delimiter the way the backend does.
 * Splitting on the last one looks right and is wrong for every uuid-suffixed TypeId — the
 * id contains dashes, so the type came back as `agentic_process-<most-of-the-uuid>`, the
 * registry lookup missed, and every scoped activity fell silently to the generic glyph.
 */
export function typeOfScope(scope?: string | null): string | null {
  if (!scope || !isTypeId(scope)) return null;
  return new TypeId(scope).type;
}

export function iconForActivity(spec: Pick<ActivityProgressSpec, 'icon' | 'scope'>): LucideIcon {
  if (spec.icon) {
    const explicit = lucideByName(spec.icon);
    if (explicit) return explicit;
  }
  const type = typeOfScope(spec.scope);
  if (type) {
    const fromRegistry = iconForType(type);
    if (fromRegistry) return fromRegistry;
  }
  return ActivityGlyph;
}
