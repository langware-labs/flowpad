/**
 * Opening a NEW (never indexed) file of a project from the file explorer must
 * land on a tab that belongs to that project — otherwise the project-filtered
 * strip hides the very tab on screen ("html opens, yet no tab", 2026-10-02,
 * sapora-streams/Spora_Admin_Flowpad_Feedback_2026-10-01.html).
 *
 * Real path, no mocks: a real Project over a fresh directory, a real file the
 * indexer has never seen, the explorer's own pointer builder
 * (`dockPointerForFile` over the `<compute_node>/<abs path>` address
 * `SimpleFileManager.buildVfsPath` produces) and the real route loader the
 * router mounts on `/dock/:viewType/*` (`loadAgentApp`), following its redirect
 * once, the way react-router does.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputeNode, Project, tabForDockKey, tabManager, tabsForProject } from '@sdk';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { dockPointerForFile } from '@src/navigation/local-file-pointer';
import { runDockLoader } from '../utils/dock-loader-harness';
import { apiTestSetup, getTestSignupInfo, trackCreatedRows } from '../utils/test-utils';

describe('a never-indexed project file opens on a tab of its project', () => {
  const signupInfo = getTestSignupInfo();
  const projectDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'unindexedtab'));
  const filePath = path.join(projectDir, 'fresh-report.html');
  const { created: cleanupProjects } = trackCreatedRows(Project.type);

  beforeEach(async (ctx: any) => {
    await apiTestSetup(signupInfo, ctx.task.name);
  });

  afterAll(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('stamps the tab with the file’s project so the project strip shows it', async () => {
    const project = await new Project({ name: projectDir }).save([]);
    cleanupProjects.push(project.id);
    fs.writeFileSync(filePath, '<!doctype html><title>fresh</title><h1>fresh</h1>');

    const node = await ComputeNode.getLocal();
    expect(node).toBeTruthy();
    const opened = dockPointerForFile(`${node!.typeId.toString()}${filePath}`);

    // The explorer's URL is unscoped; the loader may redirect it once (I2).
    const first = await runDockLoader(opened.toUrl());
    if (first.outcome === 'error') throw first.error;
    const settled = first.outcome === 'redirect' ? first.location : opened.toUrl();
    if (first.outcome === 'redirect') expect(await runDockLoader(settled)).toEqual({ outcome: 'ok' });
    const tab = tabForDockKey(tabManager.getSnapshot(), DockPointer.fromUrl(settled).tabHash);
    expect(tab, `no tab for ${settled}`).toBeTruthy();

    expect(tab!.project_id, `tab ${tab!.pointer}`).toBe(project.id);
    expect(tabsForProject(tabManager.getSnapshot(), project.id).map((t) => t.id)).toContain(tab!.id);
  });
});
