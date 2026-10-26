import { createContext } from 'react';

/**
 * The host's content epoch: bumped when what is shown may have changed behind the same address
 * (a re-show, or an agent turn that wrote). A host re-keys its body on it, which remounts a
 * viewer — and a viewer whose frame the iframe registry parks hands the same document back, so
 * it reads the epoch here and reloads that frame itself (`reloadOnNewEpoch`). Undefined outside
 * a host that has one.
 */
export const ContentEpochContext = createContext<number | undefined>(undefined);
