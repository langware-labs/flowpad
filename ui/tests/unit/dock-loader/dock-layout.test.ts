/**
 * The layout rule (docs/navigation/dock-loading.md, step 5): one pure function
 * decides which frame a dock renders in, so the answer can be checked per dock
 * instead of reverse-engineered from which component happened to mount.
 */
import contract from '../../../../tests/fixtures/dock_address_contract.json';
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { DockLayout, resolveDockLayout } from '@src/navigation/dock-layout';

const P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const dock = (url: string) => DockPointer.fromUrl(url);

describe('resolveDockLayout', () => {
  it.each([
    // [what, url, isVibe, hasVibeSession, layout, chat beside the asset]
    ['a shell in Standard', `/dock/shell/agentic_process-${PROC}`, false, false, DockLayout.CONTENT, false],
    ['a process in Vibe', `/dock/shell/agentic_process-${PROC}?viewMode=vibe`, true, true, DockLayout.VIBE_WORKSPACE, false],
    ['a Vibe host tab', `/dock/vibe/agentic_process-${PROC}`, true, true, DockLayout.VIBE_WORKSPACE, false],
    // Hosting belongs to the tab: a Vibe host renders its workspace even if the
    // ambient mode were not Vibe (its address implies Vibe, so this is a guard).
    ['a Vibe host tab, whatever the ambient mode', `/dock/vibe/agentic_process-${PROC}`, false, true, DockLayout.VIBE_WORKSPACE, false],
    [
      'the report a terminal link opened (the 2026-09-27 repro)',
      `/dock/project/${P}/editor/markdown/vfs/compute_node-%40local/w/p/report.md`,
      false,
      false,
      DockLayout.ASSET_WORKSPACE,
      false,
    ],
    [
      'the same report in Vibe but with no host: no chat beside it (the mode never decides)',
      `/dock/project/${P}/editor/markdown/vfs/compute_node-%40local/w/p/report.md?viewMode=vibe`,
      true,
      false,
      DockLayout.ASSET_WORKSPACE,
      false,
    ],
    [
      "the report as a Vibe host's child (Discuss): its host's chat sits beside it",
      `/dock/project/${P}/editor/markdown/vfs/compute_node-%40local/w/p/report.md?viewMode=vibe&host=agentic_process-${PROC}`,
      true,
      true,
      DockLayout.ASSET_WORKSPACE,
      true,
    ],
    [
      'an agent in Vibe: it has its own chat, so none beside it',
      '/dock/assets/editor/agent/vfs/compute_node-%40local/w/p/.claude/agents/helper.md?viewMode=vibe',
      true,
      false,
      DockLayout.ASSET_WORKSPACE,
      false,
    ],
    [
      "the agent's own flow-show preview stays in the workspace display",
      `/dock/assets/editor/html/vfs/compute_node-%40local/w/p/site/index.html?viewMode=vibe&activeDisplay=1&host=agentic_process-${PROC}`,
      true,
      true,
      DockLayout.VIBE_WORKSPACE,
      false,
    ],
    ['the bare home in Vibe', '/dock/home?viewMode=vibe', true, false, DockLayout.VIBE_NEW_CHAT, false],
    ['a no-process home in Vibe', '/dock/home?viewMode=vibe&vibeNoProcess=true', true, false, DockLayout.VIBE_NO_PROCESS, false],
    ['a project landing in Vibe (a destination, not a workspace)', `/dock/project/${P}?viewMode=vibe`, true, false, DockLayout.CONTENT, false],
    ['the hub page is never skinned by the desk view mode', '/dock/hub/records/project', true, false, DockLayout.CONTENT, false],
  ])('%s', (_what, url, isVibe, hasVibeSession, layout, chatBeside) => {
    expect(resolveDockLayout({ dock: dock(url), isVibe, hasVibeSession })).toEqual({
      layout,
      assetChatBeside: chatBeside,
    });
  });

  it('no dock is the home', () => {
    expect(resolveDockLayout({ dock: null, isVibe: true, hasVibeSession: false }).layout).toBe(DockLayout.VIBE_NEW_CHAT);
    expect(resolveDockLayout({ dock: null, isVibe: false, hasVibeSession: false }).layout).toBe(DockLayout.CONTENT);
  });

  it('answers for every URL family in the grammar fixture, in every mode', () => {
    const layouts = new Set(Object.values(DockLayout));
    for (const c of contract.url_cases as { url: string }[]) {
      if (c.url.startsWith('/agent/')) continue;
      for (const isVibe of [false, true]) {
        for (const hasVibeSession of [false, true]) {
          expect(layouts.has(resolveDockLayout({ dock: dock(c.url), isVibe, hasVibeSession }).layout), c.url).toBe(true);
        }
      }
    }
  });
});
