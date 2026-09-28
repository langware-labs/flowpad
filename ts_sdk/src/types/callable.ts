/**
 * A plain callback type.
 *
 * Its own module rather than the `types` barrel: `APIEntity` needs it, and the
 * barrel re-exports `entities/compute-node/*`, which put the base class in a cycle
 * with itself (`ui/tests/unit/sdk-module-layering.test.ts`).
 */
export type Callable = (...args: any[]) => void;
