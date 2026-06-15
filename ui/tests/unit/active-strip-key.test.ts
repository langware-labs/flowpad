/**
 * Regression test for "selected tab becomes the agentic process".
 *
 * Repro: open /dock/assets/list/<x> (Assets tab active), click Assets on the
 * side rail → lands on the rootless bare /dock/assets. Its Tab isn't in the
 * strip's contentByKey (unmaterialized / rootless), so the OLD activeKey
 * fell back to the terminal controller's MRU key — leaving the agentic-process
 * chip selected while the Assets panel was on screen (persistently).
 *
 * Fix: ui/src/tabs/active-strip-key.ts — a content dock is active by its own
 * tabHash; only terminal (shell) docks resolve via the controller key.
 */

import { DockPointer } from '@src/navigation/DockPointer';
import { activeStripKey } from '@src/tabs/active-strip-key';
import { describe, expect, it } from 'vitest';

describe('activeStripKey — URL-first strip active highlight', () => {
  it('a content dock with NO materialized Tab is active by its own tabHash, NOT the MRU terminal', () => {
    const bareAssets = DockPointer.fromUrl('assets'); // rootless /dock/assets
    // An agentic-process terminal is the controller's MRU — it must be ignored.
    expect(activeStripKey(bareAssets, 'agentic_process-bc7d9fd5')).toBe('assets|');
  });

  it('a content dock with a sub-path is active by its full tabHash', () => {
    const list = DockPointer.fromUrl('assets', 'list/flowpad_diagnosis');
    expect(activeStripKey(list, 'agentic_process-bc7d9fd5')).toBe('assets|list/flowpad_diagnosis');
  });

  it('a terminal (shell) dock resolves via the controller key', () => {
    const shell = DockPointer.fromUrl('shell', 'agentic_process-bc7d9fd5');
    expect(activeStripKey(shell, 'agentic_process-bc7d9fd5')).toBe('agentic_process-bc7d9fd5');
  });

  it('no current dock → nothing active', () => {
    expect(activeStripKey(null, 'agentic_process-bc7d9fd5')).toBe('');
  });
});
