/** A stand-in for `DockPointer` in unit tests: its options plus `withOption`, which is all a place component reads. */
export type FakeDock = { options: Record<string, string>; withOption: (k: string, v: string | null) => FakeDock };

export function fakeDock(options: Record<string, string> = {}): FakeDock {
  return {
    options,
    withOption: (k, v) => {
      const next = { ...options };
      if (v) next[k] = v;
      else delete next[k];
      return fakeDock(next);
    },
  };
}
