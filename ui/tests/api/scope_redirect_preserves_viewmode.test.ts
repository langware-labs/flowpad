/**
 * `reconcileProcessScope` query preservation — the one-tab-model must-fix.
 *
 * Every process open runs the shell loader; for a project-owned process whose
 * URL carries no scope keys, the loader `replace()`-redirects onto the same
 * pointer with the process's own project scope. That redirect historically
 * dropped ALL query options — under the one-tab model (vibe = `?viewMode` on
 * the shell URL, no display URL family) that silently stripped view mode,
 * side-window state, and deep-link metadata.
 *
 * Drives the REAL exported `loadShellRoute` against the running backend and
 * asserts the thrown redirect Response carries the project scope and every
 * unrelated query option.
 */
import { AgenticProcess } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { loadShellRoute } from '@src/routes/loaders/load-shell';
import { ViewMode } from '@src/contexts/view-mode-context';
import { projectScope } from '@src/lib/scope-filter';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

/** Run a loader and return the redirect Response it throws (null if none). */
async function captureRedirect(run: () => Promise<void>): Promise<Response | null> {
  try {
    await run();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  return null;
}

describe('api: scope-align redirect preserves query options', () => {
  const info = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
  });

  it('project-owned process + no scope on URL → redirect keeps viewMode=vibe', async () => {
    const id = uuidv4();
    const projectId = uuidv4();
    await new AgenticProcess({
      id,
      name: 'scoped vibe process',
      worker_type: 'claude_code',
      project_id: projectId,
    } as any).save();

    const redirect = await captureRedirect(() =>
      loadShellRoute(`agentic_process-${id}`, '/dock/shell', {
        viewMode: ViewMode.Vibe,
        options: {
          viewMode: ViewMode.Vibe,
          sideWindows: 'dir',
          matrix: 'legacy',
        },
      }),
    );

    expect(redirect, 'scope divergence must throw the replace() redirect').not.toBeNull();
    const location = redirect!.headers.get('Location') ?? '';
    expect(location).toContain(`agentic_process-${id}`);
    expect(location).toContain(`scope-activeProjectId=${projectId}`);
    expect(location).toContain('viewMode=vibe');
    expect(location).toContain('sideWindows=dir');
    expect(location).toContain('matrix=legacy');
  }, 15000);

  it('standard entry (no viewMode) redirects without inventing one', async () => {
    const id = uuidv4();
    const projectId = uuidv4();
    await new AgenticProcess({
      id,
      name: 'scoped standard process',
      worker_type: 'claude_code',
      project_id: projectId,
    } as any).save();

    const redirect = await captureRedirect(() => loadShellRoute(`agentic_process-${id}`, '/dock/shell'));

    expect(redirect).not.toBeNull();
    const location = redirect!.headers.get('Location') ?? '';
    expect(location).toContain(`scope-activeProjectId=${projectId}`);
    expect(location).not.toContain('viewMode=');
  }, 15000);

  it('projectless process clears an ambient project scope before tab materialization', async () => {
    const id = uuidv4();
    const ambientProjectId = uuidv4();
    await new AgenticProcess({
      id,
      name: 'global codex process',
      worker_type: 'codex',
      project_id: null,
      workdir: '/tmp/outside-every-project',
      pty_mode: false,
    } as any).save();

    const redirect = await captureRedirect(() =>
      loadShellRoute(`agentic_process-${id}`, '/dock/shell', {
        scope: projectScope(ambientProjectId),
        options: {
          'scope-mode': 'project',
          'scope-activeProjectId': ambientProjectId,
          viewMode: ViewMode.Vibe,
          matrix: 'global',
        },
        viewMode: ViewMode.Vibe,
      }),
    );

    expect(redirect).not.toBeNull();
    const location = redirect!.headers.get('Location') ?? '';
    expect(location).toContain(`agentic_process-${id}`);
    expect(location).toContain('viewMode=vibe');
    expect(location).toContain('matrix=global');
    expect(location).not.toContain('scope-');
  });
});
