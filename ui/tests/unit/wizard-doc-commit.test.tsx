/**
 * The write discipline: validate, THEN write — and only if the verdict is ok.
 *
 * This is not a cosmetic guard. A `wizard.json` that fails validation makes the
 * wizard vanish from the product, because the indexer's reader swallows a
 * malformed document by design (one bad file must not wedge a walk of a hundred
 * assets). So the editor writing an invalid draft is data loss with no error
 * anywhere.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useWizardDoc } from '@src/components/assets/editor/wizard/useWizardDoc';
import { setIn, type WizardDoc } from '@src/components/assets/editor/wizard/wizard-doc';

const DOC: WizardDoc = { name: 'w', steps: [{ id: 'a', command: { commands: { linux: 'true' } } }] };

function harness({ ok = true, shipped = false }: { ok?: boolean; shipped?: boolean } = {}) {
  const write = vi.fn().mockResolvedValue(undefined);
  const validateDocument = vi.fn().mockResolvedValue({ ok, issues: ok ? [] : [{ msg: 'bad' }] });
  const wizard = { shipped, validateDocument } as never;
  const mainRef = { path: '/w/wizard.json', write } as never;
  const hook = renderHook(() => useWizardDoc({ wizard, mainRef, initial: DOC }));
  return { hook, write, validateDocument };
}

describe('useWizardDoc.commit', () => {
  it('validates the candidate BEFORE writing it', async () => {
    const { hook, write, validateDocument } = harness();
    await act(async () => {
      await hook.result.current.commit((d) => setIn(d, ['name'], 'renamed'));
    });

    expect(validateDocument).toHaveBeenCalledTimes(1);
    // The CANDIDATE, not what is on disk — that is the whole point of asking.
    expect((validateDocument.mock.calls[0] as unknown[])[0]).toMatchObject({ name: 'renamed' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0][0])).toContain('renamed');
  });

  it('writes NOTHING when validation fails, and keeps the draft in memory', async () => {
    const { hook, write } = harness({ ok: false });
    await act(async () => {
      await hook.result.current.commit((d) => setIn(d, ['steps', 0, 'id'], ''));
    });

    expect(write).not.toHaveBeenCalled();
    expect(hook.result.current.validation?.ok).toBe(false);
    // The person keeps editing from where they were rather than losing the edit.
    expect(hook.result.current.doc?.steps?.[0].id).toBe('');
  });

  it('never writes for a wizard that ships with Flowpad', async () => {
    const { hook, write, validateDocument } = harness({ shipped: true });
    await act(async () => {
      await hook.result.current.commit((d) => setIn(d, ['name'], 'tampered'));
    });

    expect(write).not.toHaveBeenCalled();
    expect(validateDocument).not.toHaveBeenCalled();
    expect(hook.result.current.readOnly).toBe(true);
    expect(hook.result.current.doc?.name).toBe('w');
  });

  it('composes two commits in one tick instead of dropping the first', async () => {
    const { hook, write } = harness();
    // Two blurs before a re-render. Merging onto a render-captured document
    // loses the first field; merging onto the authoritative ref keeps both.
    await act(async () => {
      const { commit } = hook.result.current;
      await Promise.all([
        commit((d) => setIn(d, ['name'], 'first')),
        commit((d) => setIn(d, ['description'], 'second')),
      ]);
    });

    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    const last = JSON.parse(String(write.mock.calls[1][0])) as WizardDoc;
    expect(last.name).toBe('first');
    expect(last.description).toBe('second');
  });

  it('flush waits for the in-flight write, so a run cannot execute a stale file', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { hook, write } = harness();
    write.mockImplementationOnce(async () => { await gate; });

    let flushed = false;
    await act(async () => {
      void hook.result.current.commit((d) => setIn(d, ['name'], 'x'));
      const waiting = hook.result.current.flush().then(() => { flushed = true; });
      expect(flushed).toBe(false);
      release();
      await waiting;
    });
    expect(flushed).toBe(true);
  });
});
