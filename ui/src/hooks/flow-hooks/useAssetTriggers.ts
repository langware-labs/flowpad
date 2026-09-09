import { useMemo } from 'react';
import { QueryRequest, Trigger, type TypeId } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

/** One request for every trigger row, filtered by parent in memory — the same
 *  shape `useAssetApps` uses, and for the same reason it gives: what triggers
 *  does this thing have is a QUERY over containment, not a registry the type
 *  has to declare. */
const triggersQuery = new QueryRequest({ type: Trigger.type, name: 'asset triggers' });

const EMPTY: Trigger[] = [];

/**
 * The triggers that live inside `parent` — its own child assets.
 *
 * This replaces mirroring the backend's `wizard_<slug>_<index>` uname in TS to
 * find a row by name. That algorithm was duplicated across two languages, and
 * being POSITIONAL it silently matched the wrong row whenever a wizard's
 * triggers were reordered. Containment is the real relationship and
 * `parent_type_id` is where the indexer already records it.
 */
export function useAssetTriggers(parent: TypeId | null | undefined): Trigger[] {
  const { data: triggers = EMPTY } = useEntitiesQuery<Trigger>(triggersQuery);
  const parentKey = parent?.toString() ?? '';
  return useMemo(
    () => (parentKey ? triggers.filter((t: Trigger) => t.parent_type_id === parentKey) : EMPTY),
    [triggers, parentKey],
  );
}
