/**
 * Regression test: TriggersView uses a hardcoded relative URL ('/api/v1/rules')
 * for its fetch call, which hits the Vite dev server (localhost:4097) instead of
 * the backend API server (localhost:9007 via __API_URL__).  The dev server has no
 * proxy rule for /api/v1/rules and returns the SPA HTML shell; JSON.parse fails
 * silently in the catch block and `rules` stays empty forever.
 *
 * The correct URL must be an absolute URL built from __API_URL__.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

// Read the source files that contain the fetch calls.
const SRC_ROOT = resolve(__dirname, '../../src/components/triggers-view');

function readSrc(filename: string): string {
  return readFileSync(resolve(SRC_ROOT, filename), 'utf-8');
}

const triggersViewSrc = readSrc('TriggersView.tsx');
const triggerEditorSrc = readSrc('TriggerEditor.tsx');
const triggerListItemSrc = readSrc('TriggerListItem.tsx');

/**
 * Each fetch call in the triggers-view components should NOT use a bare relative
 * path like  fetch('/api/v1/...')  — that resolves to the Vite dev server, not
 * the backend.  Instead it must use an absolute URL constructed from __API_URL__
 * (or an equivalent helper that embeds the backend base URL).
 */
describe('triggers-view fetch URLs', () => {
  it('TriggersView should not fetch /api/v1/rules with a bare relative URL', () => {
    // This assertion FAILS currently — the source contains fetch('/api/v1/rules').
    expect(triggersViewSrc).not.toMatch(/fetch\s*\(\s*['"`]\/api\/v1\/rules['"`]/);
  });

  it('TriggerEditor should not fetch /api/v1/rules with bare relative URLs', () => {
    // Both the GET and PUT calls use fetch(`/api/v1/rules/${rule.name}/trigger`).
    expect(triggerEditorSrc).not.toMatch(/fetch\s*\(\s*`\/api\/v1\/rules\//);
  });

  it('TriggerListItem should not fetch /api/v1/rules with bare relative URLs', () => {
    expect(triggerListItemSrc).not.toMatch(/fetch\s*\(\s*`\/api\/v1\/rules\//);
  });
});
