/**
 * FLOWPAD-2300: the project page's Customize tab must render when the manifest
 * declares its home page as a project-relative path.
 *
 * `home_page` in `project_manifest.json` may be an asset TypeId OR a `./path`
 * (docs/navigation/project-home-page.md); `set-home-page` accepts both. The
 * Customize tab's `HomeCustomizationCard` read the declaration off the manifest
 * row and handed it to `new TypeId()`, which throws `Invalid typeId` on a path —
 * during render, so the route-level error boundary replaced the whole screen.
 *
 * No mocks: a real project and agent on the selected disposable backend, the
 * path declared through the real `Project.setHomePage`, the real card reading
 * the real manifest row. The boundary below stands in for the router's own
 * (`RenderErrorBoundary`), which is what turned the throw into a full-screen
 * error.
 */
import '@src/i18n-init';

import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { Agent, Project } from '@sdk';
import { HomeCustomizationCard } from '@src/components/project-home/HomeCustomizationCard';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const FLOW_INSTANCE = process.env.FLOW_INSTANCE?.trim() || '';
const FLOW_HOME = path.resolve(process.env.FLOW_HOME || path.join(homedir(), '.flow'));
const PROJECT_ROOT = path.join(FLOW_HOME, 'instances', FLOW_INSTANCE, 'react-fixtures', `home-path-${randomUUID()}`);
const AGENT_NAME = 'fp2300-home-agent';

let project: Project | null = null;
let agent: Agent | null = null;

/** Catches a render-time throw and shows its message, as the router's boundary does. */
class ScreenBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <div role="alert">{this.state.error.message}</div> : this.props.children;
  }
}

/** `./<agent folder>` relative to the project root — the documented path form. */
function pathDeclaration(projectRoot: string, assetDir: string): string {
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const dir = assetDir.replace(/\\/g, '/');
  expect(dir.toLowerCase().startsWith(`${root.toLowerCase()}/`)).toBe(true);
  return `./${dir.slice(root.length + 1)}`;
}

describe('HomeCustomizationCard — a ./path home page declaration', () => {
  beforeEach(async (ctx) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
  });

  afterAll(async () => {
    await agent?.delete().catch(() => {});
    await project?.delete().catch(() => {});
    rmSync(PROJECT_ROOT, { recursive: true, force: true });
  });

  it('renders the declared home page instead of throwing Invalid typeId', async () => {
    project = await new Project({ name: PROJECT_ROOT }).save();
    agent = await Agent.createInProject(project, AGENT_NAME);
    const declaration = pathDeclaration(project.fs_storage_mount_path!, agent.bundleDirectory!);
    expect((await project.setHomePage(declaration)).home_page).toBe(declaration);

    render(
      <I18nProvider i18n={i18n}>
        <ScreenBoundary>
          <HomeCustomizationCard project={project} />
        </ScreenBoundary>
      </I18nProvider>,
    );

    // The card shows the default until the manifest row arrives; then it either
    // names the declared agent or the boundary catches the throw.
    await waitFor(() => expect(screen.queryByRole('alert') ?? screen.queryByText(AGENT_NAME)).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(screen.queryByRole('alert')?.textContent ?? null).toBeNull();
    expect(screen.getByText(AGENT_NAME)).toBeInTheDocument();
  });
});
