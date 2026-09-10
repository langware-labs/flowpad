import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FSRef, Wizard, WizardValidation } from '@sdk';

import type { WizardDoc } from './wizard-doc';

/**
 * The editable `wizard.json`, and the discipline for writing it.
 *
 * Lifted from `McpForm` rather than reinvented, because the two hard-won parts
 * are the same: `current` is the authoritative in-memory document so two blurs
 * in one render tick compose (merging onto a render-captured value drops the
 * first one's field), and writes go through a promise queue so whole-file
 * writes land in order.
 *
 * What is NEW here is the order: **validate, then write.** A wizard document
 * that fails validation is not a cosmetic problem — the indexer's reader
 * swallows it, so saving one makes the wizard disappear from the product. So a
 * rejected draft stays in memory, nothing is written, and the person keeps
 * editing from where they were.
 */
export function useWizardDoc({
  wizard,
  mainRef,
  initial,
}: {
  wizard: Wizard;
  mainRef: FSRef;
  /** `null` until the file has been read — and permanently, if it could not be.
   *  The hook still runs (it is below a view-mode skin, which must not change
   *  which hooks execute); `commit` simply has nothing to edit. */
  initial: WizardDoc | null;
}) {
  const [doc, setDoc] = useState<WizardDoc | null>(initial);
  const [validation, setValidation] = useState<WizardValidation | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const current = useRef<WizardDoc | null>(initial);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  // Adopt the document the ONCE, when the async read lands.
  //
  // The file is read after the first paint, so seeding state from `initial`
  // alone left the draft null for the life of the mount — the step list and
  // debugger rendered empty and every edit was a silent no-op, because `commit`
  // has nothing to edit. Adopting rather than remounting is deliberate: a
  // remount keyed on "has it loaded" would throw away whatever is already on
  // screen when the read resolves, such as an open approval panel.
  //
  // Guarded by the ref so this fires exactly once per document. Re-adopting
  // later would let a re-read overwrite an edit in progress.
  const adopted = useRef(current.current !== null);
  useEffect(() => {
    if (adopted.current || initial === null) return;
    adopted.current = true;
    current.current = initial;
    setDoc(initial);
  }, [initial]);

  const readOnly = Boolean(wizard.shipped);

  /**
   * Apply an edit and persist it — unless the backend says the result is
   * broken, or this wizard ships with Flowpad.
   *
   * `edit` receives the authoritative document rather than a captured one, for
   * the composition reason above.
   */
  const commit = useCallback(
    async (edit: (previous: WizardDoc) => WizardDoc) => {
      if (readOnly || current.current === null) return;
      const next = edit(current.current);
      current.current = next;
      setDoc(next);
      setSaveError(null);
      setSaving(true);

      queue.current = queue.current
        .catch(() => undefined)
        .then(async () => {
          // Ask about the CANDIDATE, before the bytes reach disk. The backend
          // is the only validator — duplicating `WizardSpec`'s rules here is
          // how the two drift and the editor starts accepting documents the
          // reader will drop.
          const verdict = await wizard.validateDocument(next);
          setValidation(verdict);
          if (!verdict.ok) return;
          await mainRef.write(`${JSON.stringify(next, null, 2)}\n`);
        })
        .catch((err) => setSaveError(err instanceof Error ? err.message : String(err)))
        .finally(() => setSaving(false));

      await queue.current;
    },
    [mainRef, readOnly, wizard],
  );

  /** Wait for any in-flight write. A run started mid-blur would otherwise
   *  execute the PREVIOUS document — the backend runs the file, not this state. */
  const flush = useCallback(async () => {
    await queue.current.catch(() => undefined);
  }, []);

  // Memoized for the same reason as `useWizardRun`'s: the viewer's callbacks
  // list this object as a dependency, so a fresh literal per render would make
  // every one of them rebuild.
  return useMemo(
    () => ({ doc, commit, flush, validation, saveError, saving, readOnly }),
    [doc, commit, flush, validation, saveError, saving, readOnly],
  );
}
