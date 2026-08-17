/**
 * A Spotlight worker-session row must not impersonate another vendor.
 *
 * `workerHistoryToRow` derived `recordType` with a ternary that fell through to
 * `'claude_session'`, so an OpenCode result rendered Claude's mark and announced
 * "Claude" to screen readers. It cannot simply map to `'opencode_session'`
 * either: opencode deliberately has NO session entity type (its sessions live in
 * SQLite), so there is nothing in the type registry to resolve a glyph from.
 * The row therefore carries `vendorWorkerType`, and the icon comes from
 * `PROVIDER_META`.
 */
import { describe, expect, it } from 'vitest';
import { workerHistoryToRow } from '@src/components/spotlight/adapters';
import { PROVIDER_META } from '@src/tabs/provider-meta';

function entry(worker_type: string) {
  return {
    worker_type,
    worker_id: `${worker_type}-session-1`,
    project_name: 'proj',
    last_active_time: null,
  } as never;
}

describe('workerHistoryToRow', () => {
  it('never labels a non-claude vendor as a claude session', () => {
    for (const vendor of ['codex', 'copilot', 'opencode']) {
      expect(workerHistoryToRow(entry(vendor)).recordType).not.toBe('claude_session');
    }
  });

  it('maps the three vendors that HAVE a session entity type', () => {
    expect(workerHistoryToRow(entry('claude')).recordType).toBe('claude_session');
    expect(workerHistoryToRow(entry('codex')).recordType).toBe('codex_session');
    expect(workerHistoryToRow(entry('copilot')).recordType).toBe('copilot_session');
  });

  it('does not invent a session entity type for opencode', () => {
    // There is no `opencode_session` in the registry, and claiming one would
    // resolve to the generic fallback glyph rather than OpenCode's mark.
    expect(workerHistoryToRow(entry('opencode')).recordType).not.toBe('opencode_session');
  });

  it('carries the vendor so the row can be glyphed from PROVIDER_META', () => {
    for (const vendor of ['claude', 'codex', 'copilot', 'opencode']) {
      expect(workerHistoryToRow(entry(vendor)).vendorWorkerType).toBe(vendor);
    }
  });

  it('every vendor it can emit is resolvable in PROVIDER_META', () => {
    for (const vendor of ['claude', 'codex', 'copilot', 'opencode']) {
      const meta = PROVIDER_META[vendor as keyof typeof PROVIDER_META];
      expect(meta, `${vendor} missing from PROVIDER_META`).toBeTruthy();
      expect(meta.iconClassName).toBeTruthy();
    }
  });

  it('gives each vendor a DISTINCT mark — the failure mode was a shared one', () => {
    const icons = ['claude', 'codex', 'copilot', 'opencode'].map(
      (v) => PROVIDER_META[v as keyof typeof PROVIDER_META].Icon,
    );
    expect(new Set(icons).size).toBe(icons.length);
  });
});
