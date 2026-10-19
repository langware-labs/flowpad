/**
 * `show` action plumbing, no LLM: AgenticProcess.show() → backend resolves the
 * target → emit_entity_event('on_show') → WS → typed proc.onShow() payload.
 *
 * Real backend + real WS watch; the worker is never started. This is the
 * deterministic half of the flow-show feature; the agent-driven half (a real
 * Claude turn running `flow show` from instructions) lives in
 * long_tests/flow_show_display_focus.test.ts.
 */

import { AgenticProcess, Project } from '@sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { purgeTracked, trackForCleanup } from '../_cleanup';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('agentic_process show action → onShow', () => {
  let proc: AgenticProcess | null = null;
  let workdir: string | null = null;

  afterEach(async () => {
    try {
      await proc?.stop?.();
    } catch {
      /* never started a worker — best-effort */
    }
    await purgeTracked();
    if (workdir) fs.rmSync(workdir, { recursive: true, force: true });
    proc = null;
    workdir = null;
  });

  /** Create a worker-less AP, call show(target), return the on_show payload. */
  async function showRoundTrip(
    testName: string,
    target: (workdir: string) => { path?: string; port?: number },
    { inProject = false }: { inProject?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    await apiTestSetup(getTestSignupInfo(), testName);
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-show-'));

    // A dev server is placed in a project (its endpoint hangs off the project's
    // local placement), so the port case runs inside one.
    const project = inProject
      ? trackForCleanup(await new Project({ name: `ap-show-${Date.now()}`, fs_storage_mount_path: workdir }).save([]))
      : null;
    proc = await new AgenticProcess({ workdir, pty_mode: false, ...(project ? { project_id: project.id } : {}) }).save(
      [],
    );
    await proc.watch();

    const seen = new Promise<Record<string, unknown>>((resolve) => proc!.onShow(resolve));
    await proc.show(target(workdir));

    return Promise.race([
      seen,
      new Promise<never>((_, r) => setTimeout(() => r(new Error('no on_show over WS')), 10_000)),
    ]);
  }

  it('show({path}) round-trips a vfs payload to the subscriber', async (ctx: any) => {
    const payload = await showRoundTrip(ctx.task.name, (wd) => {
      const file = path.join(wd, 'hello.md');
      fs.writeFileSync(file, '# hello');
      return { path: file };
    });
    expect(payload.kind).toBe('vfs');
    expect(String(payload.path)).toContain('hello.md');
  }, 30_000); // do not increase timeout without approval

  it('show({path}) recovers a docs markdown file as an entity', async (ctx: any) => {
    const payload = await showRoundTrip(ctx.task.name, (wd) => {
      const docs = path.join(wd, 'docs');
      fs.mkdirSync(docs, { recursive: true });
      const file = path.join(docs, 'hello.md');
      fs.writeFileSync(file, '# hello\n\nhello world\n');
      return { path: file };
    });
    expect(payload.kind).toBe('entity');
    expect(payload.type).toBe('markdown');
    expect(String(payload.typeid)).toMatch(/^markdown-[0-9a-f-]{36}$/);
    expect(String(payload.path)).toContain(path.join('docs', 'hello.md'));
  }, 30_000); // do not increase timeout without approval

  it('show({port}) registers the dev server as an endpoint and shows THAT', async (ctx: any) => {
    const payload = await showRoundTrip(ctx.task.name, () => ({ port: 3000 }), { inProject: true });
    expect(payload.kind).toBe('app');
    expect(payload.runtime).toBe('dev');
    // The address is the endpoint, never the port.
    expect(String(payload.typeid)).toMatch(/^service_endpoint-[0-9a-f-]{36}$/);
    expect(payload.endpoint_id).toBe(String(payload.typeid).slice('service_endpoint-'.length));
    expect(payload.port).toBeUndefined();
  }, 30_000); // do not increase timeout without approval
});
