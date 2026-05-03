import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { unionKeys } from './keys';

/**
 * Carries the set of chip keys already rendered at higher levels so deeper
 * chip rows (e.g. MessageChips) can skip duplicates without prop-drilling.
 *
 * Provider stacks: each ``ChipsExcludeProvider`` *adds* to the inherited
 * exclude set, so wrapping a ``ConversationChips`` in a provider seeded with
 * ``taskChipKeys`` and then wrapping ``MessageBubble``s in another provider
 * seeded with ``conversationChipKeys`` results in MessageChips seeing both.
 */
const ChipsExcludeContext = createContext<Set<string>>(new Set());

/** Read the current exclude set inherited from ancestors. */
export function useChipsExclude(): Set<string> {
  return useContext(ChipsExcludeContext);
}

interface ChipsExcludeProviderProps {
  /** Keys to add on top of the inherited exclude set. */
  add?: Set<string>;
  children: ReactNode;
}

/**
 * Wrap a subtree to extend the chip exclude set. Inherited keys are merged
 * with ``add`` so nesting is additive (a child sees both its parent's and
 * grandparent's keys).
 */
export function ChipsExcludeProvider({ add, children }: ChipsExcludeProviderProps) {
  const parent = useChipsExclude();
  const value = useMemo(
    () => (add && add.size > 0 ? unionKeys(parent, add) : parent),
    [parent, add],
  );
  return <ChipsExcludeContext.Provider value={value}>{children}</ChipsExcludeContext.Provider>;
}
