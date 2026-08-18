/**
 * A lens tab must follow its target's project when that project drifts.
 *
 * The proven production failure (RCA 2026-07-14, "no selected tab" on
 * /dock/lens/claude/transcript/<id>): `tab.project_id` is a mint-time snapshot
 * of the target claude_session's project. The indexer legitimately re-stamps
 * the session's `project_id` later through the disk→DB adopt path
 * (`discover_record_by_path` → deepest-mount-wins on the transcript's PHYSICAL
 * path → `FSRecord.sync_to_db`), which BY DESIGN skips the
 * `reconcile_tab_project` save-hook. The FE reuse gate (`materializeTab`,
 * ui/src/tabs/tab-lifecycle.ts) then reuses the existing lens tab VERBATIM —
 * `dockAddressesAsset()` is false for lens docks, so the getFromDockPointer
 * re-derive branch is unreachable — leaving the snapshot stale forever. The
 * strip filters tabs by `tab.project_id === activeProject`, and the loader
 * activates the SESSION's project, so the very tab whose content is on screen
 * is hidden: no selected tab.
 *
 * This test mirrors the production state 1:1:
 *   - the tab gets the CWD-resolved project at mint (the real FE fallback —
 *     prod's flowpad-oss project),
 *   - the session is later re-stamped to an UMBRELLA project whose mount
 *     contains the transcript file (prod's "/Users/shlom" home project, which
 *     contains ~/.claude), via the product's own scoped index endpoint.
 *
 * Invariant under test: after a load through the real UI path, the lens tab's
 * `project_id` equals its target claude_session's `project_id`.
 *
 * Everything is real — a real transcript JSONL under the backend's
 * FLOWPAD_CLAUDE_HOME, real Project rows, the product's own
 * `fs-records/index?type=claude_session&path=<jsonl>` seam, and the real UI
 * load path (`setupTab` → `materializeTab`). No mocks, no hand-forced rows.
 *
 * Requires FLOWPAD_CLAUDE_HOME pointing at the SAME directory the target
 * backend instance was launched with (so the test writes transcripts where the
 * backend reads them); skips otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeSession, ComputeNode, GRAPH_API_PREFIX, Project, Tab, apiClient, dataManager } from '@sdk';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { DockPointer } from '@src/navigation/DockPointer';
import { setupTab } from '@src/tabs/tab-content-lifecycle';
import { apiTestSetup, getTestSignupInfo, trackCreatedRows } from '../utils/test-utils';

const CLAUDE_HOME = process.env.FLOWPAD_CLAUDE_HOME || '';
const CN_FS_BASE = `${GRAPH_API_PREFIX}/${ComputeNode.type}/@local/fs-records`;

// A no-op content adapter so `setupTab` exercises ONLY the materialize path
// (tab create/resolve), not any view-specific editor side effects.
const noopAdapter = {
  setupTab: async () => ({ tab: null as Tab | null }),
  cleanupTab: async () => {},
};

/** Run the real UI load path and return the resulting tab. */
async function loadLensTab(dock: DockPointer): Promise<Tab> {
  const { tab } = await setupTab(dock, { adapter: noopAdapter });
  expect(tab).toBeTruthy();
  return tab!;
}

/** Index ONE transcript through the product's scoped index seam. */
async function indexTranscript(jsonlPath: string): Promise<void> {
  await apiClient.post(
    `${CN_FS_BASE}/index?type=claude_session&path=${encodeURIComponent(jsonlPath)}`,
    {},
  );
}

describe.skipIf(!CLAUDE_HOME)('lens tab follows its target session project across an indexer re-stamp', () => {
  const signupInfo = getTestSignupInfo();

  // Path segments must contain no '-' or '_' — the claude encoded-dir scheme
  // decodes '-' back to '/'. Digits are safe.
  const stamp = Date.now().toString();
  const workDir = path.join(path.dirname(CLAUDE_HOME), `work${stamp}`);
  const sessionId = uuidv4();
  const encoded = workDir.replace(/\//g, '-');
  const jsonlPath = path.join(CLAUDE_HOME, 'projects', encoded, `${sessionId}.jsonl`);
  // The per-run project whose mount CONTAINS the transcript file — the
  // "/Users/shlom" analog (prod's home project contains ~/.claude). Scoped to
  // this run's unique encoded dir so reruns never poison each other.
  const umbrellaMount = path.dirname(jsonlPath);

  const envelope = (text: string) =>
    JSON.stringify({
      sessionId,
      cwd: workDir,
      timestamp: new Date().toISOString(),
      type: 'user',
      message: { role: 'user', content: text },
    }) + '\n';

  beforeEach(async (ctx: any) => {
    await apiTestSetup(signupInfo, ctx.task.name);
  });

  const { created: cleanupProjects } = trackCreatedRows(Project.type);

  afterAll(() => {
    fs.rmSync(path.dirname(jsonlPath), { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('re-derives the tab project after the session re-stamps to the transcript-holding project', async () => {
    // ── Phase 1: real cwd project + transcript; session indexed via the scoped
    // seam. No mount contains the JSONL yet → the session row has no project;
    // the tab mint resolves its project from the session's CWD (the real FE
    // fallback — exactly how prod stamped the flowpad-oss project on the tab).
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
    fs.writeFileSync(jsonlPath, envelope('hello'));

    const cwdProject = await new Project({ name: workDir }).save([]);
    cleanupProjects.push(cwdProject.id);
    await indexTranscript(jsonlPath);

    const before = await ClaudeSession.getById<ClaudeSession>(sessionId);
    expect(before.cwd).toBe(workDir);

    const dock = DockPointer.forLensTranscript('claude', sessionId);
    const minted = await loadLensTab(dock);
    expect(minted.project_id).toBe(cwdProject.id);

    // ── Phase 2: an umbrella project whose mount CONTAINS the transcript file
    // (the "/Users/shlom" analog) appears; the transcript changes; the next
    // scoped index re-stamps the session to the umbrella via deepest-mount-wins
    // on the transcript's physical path — through sync_to_db, which skips the
    // tab reconcile save-hook. The tab snapshot is now stale.
    const umbrella = await new Project({ name: umbrellaMount }).save([]);
    cleanupProjects.push(umbrella.id);
    expect(umbrella.id).not.toBe(cwdProject.id);

    fs.appendFileSync(jsonlPath, envelope('world'));
    await indexTranscript(jsonlPath);
    await dataManager.clearCache(); // fresh target fetch, like a page reload

    const after = await ClaudeSession.getById<ClaudeSession>(sessionId);
    // Drift sanity: the re-index really moved the session to the umbrella.
    expect(after.project_id).toBe(umbrella.id);

    // ── Phase 3: reload the SAME dock through the real UI path. The invariant
    // the tab strip depends on: the tab's project equals its target's project.
    // Today materializeTab reuses the stale row verbatim → this fails with the
    // tab still on the cwd project — the exact "no selected tab" mechanism.
    const reloaded = await loadLensTab(dock);
    expect(reloaded.project_id).toBe(after.project_id);
  }, 15000);
});
