/**
 * Full analysis flow — browser layer (real Chrome, real backend).
 * Source: full_analysis_flow.md
 *
 * Walks the flow the user defined, against the live stack:
 *   create the product-finder skill (fixture, git v1) → seed a skill-loaded
 *   analysis over the real HTTP routes → OPEN THE ANALYSIS in real Chrome and
 *   assert it renders → run the improve→diff→version loop (≤3 cycles, stop when
 *   an analysis is clean), asserting the version bumps each cycle.
 *
 * Per the agreed design the agentic steps (shopper run / analysis / skillit) are
 * attempted for real on demand; here they are SEEDED through the same routes the
 * UI uses so the browser spec is reproducible (real agents = e2e-qa Phase 11,
 * rate-limited/non-deterministic). The git/version contract and the real-Chrome
 * render of the analysis are exercised live.
 *
 * Run: cd ui && VITE_PORT=<frontend> npx playwright test \
 *        --config tests/manual_regression/skills/playwright.config.ts full_analysis_flow.md.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, request as pwRequest } from '@playwright/test';
import { apiOrigin } from '../_shared/api';

const SID = '66666666-6666-4666-8666-666666666666';
const SKILL = 'product-finder';
const MAX_CYCLES = 3;
// Playwright runs from ui/; the fixture lives at <repo>/tests/fixtures/…
const FIXTURE = join(process.cwd(), '..', 'tests', 'fixtures', 'product-finder', 'SKILL.md');

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'pipe' });

function scaffoldSkillRepo(): { repo: string; skillDir: string } {
  const repo = join(tmpdir(), `flowpad-fullflow-${Date.now()}`);
  const skillDir = join(repo, '.claude', 'skills', SKILL);
  mkdirSync(skillDir, { recursive: true });
  git(['init'], repo);
  git(['config', 'user.email', 't@t.test'], repo);
  git(['config', 'user.name', 't'], repo);
  copyFileSync(FIXTURE, join(skillDir, 'SKILL.md'));
  git(['add', '-A'], repo);
  git(['commit', '-m', `Flowpad: ${SKILL} v1`], repo);
  return { repo, skillDir };
}

function seedSkillLoadedTranscript(): string {
  const dir = join(homedir(), '.claude', 'projects', '-fullflow-browser');
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', uuid: 'u1', sessionId: SID, timestamp: '2026-06-25T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'search for smartphone' }] } },
    { type: 'assistant', uuid: 'a1', sessionId: SID, timestamp: '2026-06-25T10:00:05Z',
      message: { id: 'm1', model: 'claude', content: [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: SKILL } }] } },
    { type: 'user', uuid: 'u2', sessionId: SID, timestamp: '2026-06-25T10:00:06Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'loaded' }] } },
  ];
  const path = join(dir, `${SID}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return path;
}

const annotations = (found: boolean) =>
  found
    ? { verdict: 'mixed', verdict_reason: 'missed the price-range step',
        issues: [{ ts: '2026-06-25T10:00:05Z', label: 'did not honor price range', severity: 'attention',
                   skill: SKILL, section_hint: 'Search online', evidence: { quote: 'smartphone', ts: '2026-06-25T10:00:05Z' } }] }
    : { verdict: 'ok', verdict_reason: 'skill is solid' };

test.describe('Full analysis flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });
  });

  test('create skill → open analysis in real Chrome → improve/version loop (≤3, converge)', async ({ page }) => {
    test.setTimeout(120_000);
    const { repo, skillDir } = scaffoldSkillRepo();
    const transcriptPath = seedSkillLoadedTranscript();
    const api = await pwRequest.newContext({ baseURL: apiOrigin() });
    const traceIds: string[] = [];

    try {
      // Step 5 — seed the first analysis (skill-loaded session → by_skill finding).
      const seedTrace = async (found: boolean) => {
        const res = await api.post(`/api/v1/workers/claude/${SID}/agent-trace`, { data: { annotations: annotations(found) } });
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        traceIds.push(body.id);
        return body as { id: string; summary: { issue_count: number } };
      };
      const first = await seedTrace(true);
      expect(first.summary.issue_count).toBeGreaterThanOrEqual(1);

      // Step 6 — OPEN THE ANALYSIS in real Chrome; the AgentTrace editor renders.
      await page.goto(`/dock/assets/editor/agent_trace/typeid/agent_trace-${first.id}`);
      await expect(page.getByTestId('agent-trace-editor')).toBeVisible({ timeout: 25_000 });

      // Steps 7–9 — improve→diff→version loop. Converge on cycle 3 (clean analysis).
      const params = { workdir: skillDir, file: 'SKILL.md' };
      let cycles = 0;
      for (let i = 0; i < MAX_CYCLES + 2; i++) {
        const trace = i === 0 ? first : await seedTrace(i < 2);
        const improvable = trace.summary.issue_count > 0;
        if (cycles >= MAX_CYCLES || !improvable) break;

        // Improve (seeded skillit edit) → diff shows it → Save & create version.
        const md = join(skillDir, 'SKILL.md');
        writeFileSync(md, readFileSync(md, 'utf-8').replace('Search online', `Search online (refined v${cycles + 2})`), 'utf-8');
        const diff = await api.get('/api/v1/graph/compute_node/@local/git-ops/diff', { params: { ...params, status: 'M' } });
        expect((await diff.json()).data.diff).toContain('refined');
        const commit = await api.post('/api/v1/graph/compute_node/@local/commit-asset', { data: params });
        cycles++;
        expect((await commit.json()).data.version).toBe(cycles + 1); // v1 → v2 → v3
      }
      expect(cycles).toBe(2); // two improvements, then a clean analysis stopped the loop
      const log = String(git(['log', '--oneline'], skillDir));
      expect((log.match(/product-finder v/g) ?? []).length).toBeGreaterThanOrEqual(3);
    } finally {
      for (const id of traceIds) await api.delete(`/api/v1/graph/agent_trace/${id}`).catch(() => {});
      await api.dispose();
      rmSync(transcriptPath, { force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
