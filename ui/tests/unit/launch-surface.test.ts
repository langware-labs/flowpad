import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, launchSurfaceField, serializeAgenticContext, setLaunchSurface } from '@sdk';

/**
 * The app stamp behind the `COMMON_UI` system-prompt layer
 * (`flow_sdk/builtin/agentic_process/system_prompt.py`, docs/agent/system-prompt-layers.md).
 *
 * `common_ui.md` must reach every process the Flowpad app launches and no process a TS
 * SDK script launches. The app sets the surface once at boot; every process-creating
 * call reads it through `launchSurfaceField()`. These pin both halves: the seam carries
 * it, and no launcher in the app goes around the seam. The backend half — what the
 * stamp turns into, per vendor and turn path — is the Python system-prompt matrix.
 */

const SRC = resolve(__dirname, '../../src');
const SDK = resolve(__dirname, '../../../ts_sdk/src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

afterEach(() => setLaunchSurface(null));

describe('the seam', () => {
  it('a TS SDK script sends no surface', () => {
    expect(launchSurfaceField()).toEqual({});
    expect(serializeAgenticContext({ workdir: '/w' } as any)).not.toHaveProperty('launch_surface');
  });

  it('once the app sets it, createProcess carries it — and contextData cannot relabel the launch', () => {
    setLaunchSurface('app');
    const body = serializeAgenticContext({ workdir: '/w', contextData: { launch_surface: 'other' } } as any);
    expect(body.launch_surface).toBe('app');
  });

  it('Agent.use and Agent.useDeployment carry it in the use body', async () => {
    setLaunchSurface('app');
    const agent = new Agent({ id: '7c9e6679-7425-40de-944b-e07fc1f90ae7' } as any);
    const post = vi.spyOn(agent as any, 'post').mockResolvedValue({ process_id: 'p' });

    await agent.use('proj');
    await agent.useDeployment('d');

    expect(post).toHaveBeenNthCalledWith(1, 'use', expect.objectContaining({ launch_surface: 'app', project_id: 'proj' }));
    expect(post).toHaveBeenNthCalledWith(2, 'use', expect.objectContaining({ launch_surface: 'app', deployment_id: 'd' }));
  });
});

describe('the app', () => {
  it('sets the surface at boot, before anything can launch', () => {
    const main = readFileSync(join(SRC, 'main.tsx'), 'utf-8');
    const init = main.slice(main.indexOf('async function init()'));
    expect(init.indexOf("setLaunchSurface('app')")).toBeGreaterThan(-1);
    expect(init.indexOf("setLaunchSurface('app')")).toBeLessThan(init.indexOf('initDesktopBackend('));
  });

  it('the agent auto-launch and a session adopted into a terminal carry it', () => {
    const redirect = readFileSync(join(SRC, 'agents/agent-auto-launch-redirect.ts'), 'utf-8');
    expect(redirect).toMatch(/AGENT_AUTO_LAUNCH_ENDPOINT,\s*\{[^}]*\.\.\.launchSurfaceField\(\)/s);
    const process = readFileSync(join(SDK, 'process/agentic-process.ts'), 'utf-8');
    const adopt = process.slice(process.indexOf('static async getByWorkerId'));
    expect(adopt.slice(0, adopt.indexOf('callAction'))).toContain('launchSurfaceField()');
  });

  it('no app code creates a process around the seam', () => {
    // Every process the app makes goes through ComputeNode.createProcess (serializeAgenticContext),
    // Agent.use / useDeployment, the auto-launch endpoint, or getByWorkerId — each stamped above.
    // A raw createProcess ActionInfo or a hand-built use/auto-launch call would launch unstamped.
    const offenders = sourceFiles(SRC).filter((path) => {
      const text = readFileSync(path, 'utf-8');
      return (
        /new ActionInfo\(\s*'createProcess'/.test(text) ||
        (/AGENT_AUTO_LAUNCH_ENDPOINT/.test(text) && /apiClient\.post/.test(text) && !/launchSurfaceField\(\)/.test(text))
      );
    });
    expect(offenders).toEqual([]);
  });
});
