/**
 * Phase-1: verifies the self-heal WIRING seam end-to-end at the logic level —
 * the strip's candidate keys, recency extraction, and that they integrate with
 * `resolveActive` to actually fix both bugs.
 *
 * Bug 2 hinges on the chip's pending-intent key matching the strip's candidate
 * key; Bug 1 hinges on recency (last_active_at) selecting the last-viewed tab.
 */
import { describe, expect, it } from 'vitest';
import { AgenticProcess, Shell, TypeId } from '@sdk';
import { type TerminalTab } from '@src/hooks/useActiveTerminals';
import { buildTabCandidates, sessionLastActiveMs } from '@src/tabs/tab-candidates';
import { resolveActive } from '@src/tabs/tab-model';
import { procTab, shellTab, uid } from '../utils/terminal-tab-fixtures';

const withLastActive = (tab: TerminalTab, iso: string): TerminalTab => ({
  ...tab,
  shell: { last_active_at: iso } as unknown as Shell,
});

describe('sessionLastActiveMs', () => {
  it('parses an ISO last_active_at to epoch ms', () => {
    const tab = withLastActive(shellTab('a'), '2020-01-02T03:04:05.000Z');
    expect(sessionLastActiveMs(tab)).toBe(Date.parse('2020-01-02T03:04:05.000Z'));
  });

  it('returns null when there is no last_active_at', () => {
    expect(sessionLastActiveMs(shellTab('a'))).toBeNull();
  });

  it('prefers the AgenticProcess (tab identity) over the transport shell', () => {
    const tab: TerminalTab = {
      ...procTab('p'),
      agenticProcess: { last_active_at: '2022-01-01T00:00:00Z' } as unknown as AgenticProcess,
      shell: { last_active_at: '2000-01-01T00:00:00Z' } as unknown as Shell,
    };
    expect(sessionLastActiveMs(tab)).toBe(Date.parse('2022-01-01T00:00:00Z'));
  });
});

describe('buildTabCandidates — key format', () => {
  it('keys a process candidate the same way a footer-chip click pins its intent (Bug 2)', () => {
    const processId = 'bbbbbbbb-0000-4000-8000-000000000001';
    const tab: TerminalTab = {
      ...procTab('agent'),
      targetTypeId: new TypeId(AgenticProcess.type, processId),
      processId,
    };
    const [candidate] = buildTabCandidates([tab]);
    // the chip pins: new TypeId(AgenticProcess.type, processId).toString()
    const chipIntentKey = new TypeId(AgenticProcess.type, processId).toString();
    expect(candidate.key).toBe(chipIntentKey);
  });
});

describe('Bug 2 — chip pending intent selects the right agent', () => {
  it('resolveActive picks the chip-targeted agent over the order default', () => {
    const wanted = 'bbbbbbbb-0000-4000-8000-000000000002';
    const wantedTab: TerminalTab = {
      ...procTab('wanted'),
      targetTypeId: new TypeId(AgenticProcess.type, wanted),
      processId: wanted,
      tabOrder: 5, // NOT the lowest — would lose without the intent
    };
    const sessions = [shellTab('first', 0), wantedTab];
    const chipIntentKey = new TypeId(AgenticProcess.type, wanted).toString();

    const r = resolveActive({
      candidates: buildTabCandidates(sessions),
      urlActiveKey: null,
      pendingIntentKey: chipIntentKey,
    });
    expect(r.activeKey).toBe(chipIntentKey);
    expect(r.source).toBe('intent');
    expect(r.consumedPendingIntent).toBe(true);
  });
});

describe('Bug 1 — recency restores the last-viewed tab on round-trip', () => {
  it('resolveActive picks the most-recently-active tab, not the lowest tab_order', () => {
    const older = withLastActive(shellTab('older', 0), '2020-01-01T00:00:00Z');
    const newer = withLastActive(shellTab('newer', 9), '2024-06-01T00:00:00Z'); // higher tab_order
    const r = resolveActive({
      candidates: buildTabCandidates([older, newer]),
      urlActiveKey: null,
      pendingIntentKey: null,
    });
    expect(r.activeKey).toBe(new TypeId(Shell.type, uid('newer')).toString());
    expect(r.source).toBe('recency');
  });

  it('falls back to lowest tab_order when no tab has recency (no worse than today)', () => {
    const r = resolveActive({
      candidates: buildTabCandidates([shellTab('b', 1), shellTab('a', 0)]),
      urlActiveKey: null,
      pendingIntentKey: null,
    });
    expect(r.activeKey).toBe(new TypeId(Shell.type, uid('a')).toString());
    expect(r.source).toBe('order');
  });
});
