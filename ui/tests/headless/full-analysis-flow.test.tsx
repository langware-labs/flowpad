/**
 * Full analysis flow — integration layer (real app in jsdom vs a LIVE backend, no mocks).
 *
 * The terminal Analysis side-window (xterm/PTY) is Playwright's job — see
 * tests/manual_regression/skill-analysis/full_analysis_flow.md.ts. Here we cover
 * the jsdom-safe slice of the flow against live data:
 *   1. create the product-finder skill via the SDK,
 *   2. seed a skill-loaded session + an analysis (agent-trace) over real HTTP,
 *   3. open the ANALYSIS in the real app (the AgentTrace asset editor) and assert
 *      it renders — the "open analysis" step, no terminal needed.
 *
 * Agentic steps are seeded (deterministic); the browser layer runs them for real.
 * Prereq: a live backend. Skips itself when none is reachable.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import { setupLiveBackend, bootApp } from './_harness';
import { trackForCleanup, trackTypeId, testEntityName } from '../_cleanup';

const backend = setupLiveBackend('[full-flow]');
const SID = '55555555-5555-4555-8555-555555555555';

function seedSkillLoadedTranscript(skillName: string) {
  const dir = join(homedir(), '.claude', 'projects', '-headless-fullflow');
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', uuid: 'u1', sessionId: SID, timestamp: '2026-06-25T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'search for smartphone' }] } },
    { type: 'assistant', uuid: 'a1', sessionId: SID, timestamp: '2026-06-25T10:00:05Z',
      message: { id: 'm1', model: 'claude',
                 content: [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: skillName } }] } },
    { type: 'user', uuid: 'u2', sessionId: SID, timestamp: '2026-06-25T10:00:06Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'loaded' }] } },
  ];
  const path = join(dir, `${SID}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return () => rmSync(path, { force: true });
}

describe('full analysis flow — open analysis renders against live data (no mocks)', () => {
  it('SDK-create skill → seed skill-loaded analysis → open the analysis in the app', async () => {
    if (!backend.current) return; // soft-skip when no backend is up
    const apiUrl = backend.current.apiUrl;

    (globalThis as any).__FLOWPAD_API_URL__ = apiUrl;
    vi.resetModules();
    const sdk = await import('@sdk');
    await sdk.initSdk();

    // 1. Create the product-finder skill (the thing analyses will implicate).
    const skillName = testEntityName('skill');
    trackForCleanup(await sdk.Skill.create(skillName, 'product finder under analysis'));

    // 2. Seed a skill-loaded session + an analysis with a by_skill finding, over real HTTP.
    const cleanupTranscript = seedSkillLoadedTranscript(skillName);
    let traceId = '';
    try {
      const annotations = {
        verdict: 'mixed', verdict_reason: 'missed the price-range step',
        issues: [{ ts: '2026-06-25T10:00:05Z', label: 'did not honor price range', severity: 'attention',
                   skill: skillName, section_hint: 'Search online', evidence: { quote: 'smartphone', ts: '2026-06-25T10:00:05Z' } }],
      };
      const res = await fetch(`${apiUrl}/api/v1/workers/claude/${SID}/agent-trace`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ annotations }),
      });
      expect(res.ok).toBe(true);
      const body = await res.json();
      traceId = body.id;
      expect(traceId).toBeTruthy();
      expect(body.summary.issue_count).toBeGreaterThanOrEqual(1); // drives the issue badge
      trackTypeId('agent_trace', traceId);

      // 3. Open the analysis in the REAL app and assert the AgentTrace editor renders.
      const { container, router } = await bootApp();
      const { DockPointer } = await import('@src/navigation/DockPointer');
      const url = DockPointer.forAssetEditorByTypeId('agent_trace', new sdk.TypeId('agent_trace', traceId)).toUrl();
      await act(async () => { await router.navigate(url); });

      await screen.findByTestId('agent-trace-editor', {}, { timeout: 18000 }); // do not increase timeout without approval
      expect(container.querySelector('[data-testid="agent-trace-editor"]')).not.toBeNull();
    } finally {
      cleanupTranscript();
    }
  });
});
