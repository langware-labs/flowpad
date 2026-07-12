/**
 * `reconcileProcessScope` viewMode preservation — the one-tab-model must-fix.
 *
 * Every process open runs the shell loader; for a project-owned process whose
 * URL carries no scope keys, the loader `replace()`-redirects onto the same
 * pointer with the process's own project scope. That redirect historically
 * dropped ALL query options — under the one-tab model (vibe = `?viewMode` on
 * the shell URL, no display URL family) that would silently strip
 * `?viewMode=vibe` from every vibe entry and land the user in standard mode.
 *
 * Drives the REAL exported `loadShellRoute` against the running backend and
 * asserts the thrown redirect Response carries BOTH the project scope and the
 * threaded viewMode.
 */
import { AgenticProcess } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { loadShellRoute } from '@src/routes/loaders/load-shell';
import { ViewMode } from '@src/contexts/view-mode-context';
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

describe('api: scope-align redirect preserves ?viewMode', () => {
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
      loadShellRoute(`agentic_process-${id}`, '/dock/shell', { viewMode: ViewMode.Vibe }),
    );

    expect(redirect, 'scope divergence must throw the replace() redirect').not.toBeNull();
    const location = redirect!.headers.get('Location') ?? '';
    expect(location).toContain(`agentic_process-${id}`);
    expect(location).toContain(`scope-activeProjectId=${projectId}`);
    expect(location).toContain('viewMode=vibe');
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
});
