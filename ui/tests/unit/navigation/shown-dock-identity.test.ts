/**
 * A thing opened in a Vibe workspace is a tab OF that workspace: its own row per workspace,
 * apart from the same thing's top-level tab — keyed `<what it shows>|@<workspace>`.
 */
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const PROJ = 'dd682350-c185-52c9-a92b-d0667141b069';
const ASSET_A = 'a684848a-af63-4c8a-988e-37a2c01b20b5';
const ASSET_B = 'b1119f21-3c0e-4f77-8a1d-2f5c7d9e0011';
const HOST = 'agentic_process-abc1e873-1ae2-4c55-9242-6b4ddea51420';
const HOST_2 = 'agentic_process-11112222-3333-4444-5555-666677778888';
const APP = 'micro_app-9eb756fb-2e56-594f-9ed2-820e5dc552e9';

const target = (assetId: string): DockPointer =>
  new DockPointer(ViewType.PROJECT, `${PROJ}/editor/markdown/typeid/markdown-${assetId}`);

describe('workspace tab identity', () => {
  it('two different shows are two tabs', () => {
    expect(target(ASSET_A).withHost(HOST).tabHash).not.toBe(target(ASSET_B).withHost(HOST).tabHash);
  });

  it('an app in a workspace and the same app on its own are two tabs', () => {
    const own = new DockPointer(ViewType.APP, APP);
    expect(own.withHost(HOST).tabHash).toBe(`app|${APP}|@${HOST}`);
    expect(own.tabHash).toBe(`app|${APP}`);
  });

  it('each workspace has its own tab for a thing', () => {
    expect(target(ASSET_A).withHost(HOST).tabHash).not.toBe(target(ASSET_A).withHost(HOST_2).tabHash);
  });

  it('stores the workspace-keyed hash, never the host option', () => {
    const json = JSON.parse(target(ASSET_A).withHost(HOST).toJSON() ?? '{}');
    expect(json.tabHash).toBe(target(ASSET_A).withHost(HOST).tabHash);
    expect(json.options).toBeUndefined();
  });

  it('the workspace itself is not a tab of itself', () => {
    const vibe = DockPointer.forSession(HOST.replace('agentic_process-', '')).withHost(HOST);
    expect(vibe.tabHash ?? '').not.toContain('|@');
  });

  it('an old activeDisplay flag in a URL changes nothing', () => {
    const flagged = new DockPointer(ViewType.PROJECT, target(ASSET_A).pointer, { activeDisplay: '1' }).withHost(HOST);
    expect(flagged.tabHash).toBe(target(ASSET_A).withHost(HOST).tabHash);
  });
});
