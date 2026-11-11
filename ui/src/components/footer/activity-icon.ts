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
 *   2. the subject entity's `TypeInfo.icon`, via the registry `iconForType` reads;
 *   3. `Activity`, the generic "something is happening" glyph.
 *
 * The hub's bootstrap ships `types` too, so step 2 resolves there as well.
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
export function typeOfSubject(subject_entity?: string | null): string | null {
  if (!subject_entity || !isTypeId(subject_entity)) return null;
  return new TypeId(subject_entity).type;
}

export function iconForActivity(spec: Pick<ActivityProgressSpec, 'icon' | 'subject_entity'>): LucideIcon {
  if (spec.icon) {
    const explicit = lucideByName(spec.icon);
    if (explicit) return explicit;
  }
  const type = typeOfSubject(spec.subject_entity);
  if (type) {
    const fromRegistry = iconForType(type);
    if (fromRegistry) return fromRegistry;
  }
  return ActivityGlyph;
}
