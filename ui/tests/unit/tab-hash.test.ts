/**
 * DockPointer.tabHash, toJSON, fromJSON — the tab pointer serialization system.
 *
 * tabHash is the canonical "viewType|pointer" string used for UI active-key matching.
 * toJSON/fromJSON serialize/deserialize the DockPointer for DB storage (Tab.pointer).
 */
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { Layout, PageId, Tab } from '@sdk';
import { describe, expect, it } from 'vitest';

describe('DockPointer.tabHash', () => {
  it('is stable for the same viewType + pointer', () => {
    const a = new DockPointer(ViewType.ASSETS, 'editor/markdown/typeid/markdown-1');
    const b = new DockPointer(ViewType.ASSETS, 'editor/markdown/typeid/markdown-1');
    expect(a.tabHash).toBe(b.tabHash);
  });

  it('differs when viewType or pointer differ', () => {
    // ASSETS is scope-keyed (see assets-tab-scope-hash.test.ts); use a
    // pointer-keyed content viewType to exercise the generic identity rule.
    const assets = new DockPointer(ViewType.ASSETS).tabHash;
    const shell = new DockPointer(ViewType.SHELL, 'shell-1').tabHash;
    const doc1 = new DockPointer(ViewType.CONVERSATION, 'doc-1').tabHash;
    const doc2 = new DockPointer(ViewType.CONVERSATION, 'doc-2').tabHash;
    expect(assets).not.toBe(shell);
    expect(doc1).not.toBe(doc2);
  });

  it('is null for surfaces that are not tabs (no chip)', () => {
    // A bare shell is the terminal HOST — its sessions are the tabs, not it.
    expect(new DockPointer(ViewType.SHELL).tabHash).toBeNull();
    // Home is an app landing, never a strip chip.
    expect(new DockPointer(ViewType.HOME, 'summary').tabHash).toBeNull();
    // A missing viewType has no tab.
    expect(new DockPointer(undefined, 'x').tabHash).toBeNull();
  });

  it('a shell WITH a session is a tab (the session is the identity)', () => {
    expect(new DockPointer(ViewType.SHELL, 'agentic_process-1').tabHash).toBe('shell|agentic_process-1');
  });

  it('excludes layout — a /win popout and the /dock view are ONE tab', () => {
    const dock = new DockPointer(ViewType.ASSETS, 'doc-1', {}, Layout.DOCK);
    const win = new DockPointer(ViewType.ASSETS, 'doc-1', {}, Layout.WIN);
    expect(dock.tabHash).toBe(win.tabHash);
  });

  it('excludes the desk page — desk tabHash is byte-identical to the un-paged form', () => {
    const noPage = new DockPointer(ViewType.CONVERSATION, 'abc123');
    const desk = new DockPointer(ViewType.CONVERSATION, 'abc123', {}, Layout.DOCK, PageId.DESK);
    expect(desk.tabHash).toBe('conversation|abc123');
    expect(desk.tabHash).toBe(noPage.tabHash);
  });

  it('namespaces a non-desk page — hub and desk tabs with the same viewType/pointer never collide', () => {
    const desk = new DockPointer(ViewType.CONVERSATION, 'abc123');
    const hub = new DockPointer(ViewType.CONVERSATION, 'abc123', {}, Layout.DOCK, PageId.HUB);
    expect(hub.tabHash).toBe('hub|conversation|abc123');
    expect(hub.tabHash).not.toBe(desk.tabHash);
  });

  it('excludes transient options (query params / slot)', () => {
    const plain = new DockPointer(ViewType.SEARCH, 'q').tabHash;
    const withOpts = new DockPointer(ViewType.SEARCH, 'q', { slot: 'activeView', x: '1' }).tabHash;
    expect(plain).toBe(withOpts);
  });

  it('round-trips through the strip split: `viewType|pointer`', () => {
    // Generic (pointer-keyed) viewType — ASSETS folds its sub-pointer into a
    // scope key instead (covered in assets-tab-scope-hash.test.ts).
    const p = new DockPointer(ViewType.CONVERSATION, 'abc123');
    const hash = p.tabHash;
    const i = hash.indexOf('|');
    expect(hash.slice(0, i)).toBe(ViewType.CONVERSATION);
    expect(hash.slice(i + 1)).toBe('abc123');
  });
});

describe('DockPointer.toJSON / fromJSON', () => {
  it('toJSON serializes a dock to {"viewType","pointer"} JSON for DB storage', () => {
    const dock = new DockPointer(ViewType.CONVERSATION, 'abc123');
    const json = dock.toJSON();
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!);
    expect(parsed).toEqual({ viewType: 'conversation', pointer: 'abc123' });
  });

  it('fromJSON deserializes a stored pointer JSON back to a DockPointer', () => {
    const json = JSON.stringify({ viewType: 'conversation', pointer: 'abc123' });
    const dock = DockPointer.fromJSON(json);
    expect(dock).not.toBeNull();
    expect(dock?.viewType).toBe(ViewType.CONVERSATION);
    expect(dock?.pointer).toBe('abc123');
    expect(dock?.tabHash).toBe('conversation|abc123');
  });

  it('round-trips: toJSON → fromJSON → toJSON', () => {
    const orig = new DockPointer(ViewType.ASSETS, 'editor/markdown/typeid/doc-1');
    const json1 = orig.toJSON();
    const roundtrip = DockPointer.fromJSON(json1!);
    const json2 = roundtrip?.toJSON();
    expect(json1).toBe(json2);
  });

  it('toJSON returns null for non-tab surfaces', () => {
    expect(new DockPointer(ViewType.SHELL).toJSON()).toBeNull();
    expect(new DockPointer(ViewType.HOME).toJSON()).toBeNull();
  });

  it('fromJSON returns null on malformed input', () => {
    expect(DockPointer.fromJSON('not json')).toBeNull();
    expect(DockPointer.fromJSON('{}')).toBeNull(); // missing viewType
    expect(DockPointer.fromJSON(JSON.stringify({ viewType: 'invalid' }))).toBeNull();
  });

  it('tabHash is preserved through JSON round-trip', () => {
    const orig = new DockPointer(ViewType.SHELL, 'agentic_process-123');
    const origHash = orig.tabHash;
    const json = orig.toJSON();
    const roundtrip = DockPointer.fromJSON(json!);
    expect(roundtrip?.tabHash).toBe(origHash);
  });

  it('normalizes an entity-rooted WorldView pointer through the shared SDK decoder', () => {
    const artifactId = 'a7d50eb3-d7a7-4c06-9ee2-a8787ae2f843';
    const dock = DockPointer.fromJSON(
      JSON.stringify({
        viewType: 'worldview',
        pointer: `artifact/${artifactId}`,
        options: { color: 'cost', selected: `artifact-${artifactId}` },
      }),
    );

    expect(dock).toEqual(
      expect.objectContaining({
        viewType: ViewType.WORLDVIEW,
        pointer: 'deployment',
        page: PageId.DESK,
        options: {
          focus: `artifact-${artifactId}`,
          selected: `artifact-${artifactId}`,
          signal: 'cost',
        },
      }),
    );
    expect(dock?.tabHash).toBe('worldview|deployment');
  });
});

describe('Tab.dockPointer legacy pointer compatibility', () => {
  it('normalizes a persisted Atlas tab to the Hub organization WorldView', () => {
    const tab = new Tab({
      id: '7f0e48ac-c169-4ba7-a606-837916a2c927',
      pointer: JSON.stringify({ viewType: 'atlas', pointer: 'organization', options: { color: 'cost' } }),
    });

    expect(tab.dockPointer).toEqual(
      expect.objectContaining({
        viewType: ViewType.WORLDVIEW,
        pointer: 'organization',
        page: PageId.HUB,
        tabHash: 'hub|worldview|organization',
        options: undefined,
      }),
    );
  });

  it('normalizes a persisted entity-rooted WorldView tab before tab-key comparison', () => {
    const deploymentId = '90f0adcf-d2f5-49a2-8dcc-9ef42701cd07';
    const tab = new Tab({
      id: 'ba88f66c-02f0-4f62-9784-44b57a5f57a5',
      pointer: `worldview|deployment/${deploymentId}`,
      target_type: 'deployment',
      target_id: deploymentId,
    });

    expect(tab.dockPointer).toEqual(
      expect.objectContaining({
        viewType: ViewType.WORLDVIEW,
        pointer: 'deployment',
        options: { focus: `deployment-${deploymentId}` },
        page: PageId.DESK,
        tabHash: 'worldview|deployment',
      }),
    );
    expect(tab.getKey()).toBe('worldview|deployment');
  });

  it('normalizes stale dock/shell-<id> rows to /dock/shell/shell-<id>', () => {
    const shellId = '8fc3bec4-0f33-4333-8b2b-c95a8f0ae194';
    const tab = new Tab({
      id: '11111111-1111-4111-8111-111111111111',
      pointer: `dock/shell-${shellId}`,
      target_type: 'shell',
      target_id: shellId,
    });

    expect(tab.dockPointer).toEqual(
      expect.objectContaining({
        viewType: ViewType.SHELL,
        pointer: `shell-${shellId}`,
        tabHash: `shell|shell-${shellId}`,
      }),
    );
  });

  it('normalizes stale dock/agentic_process-<id> rows to shell agentic tabs', () => {
    const processId = 'f7d3f87c-4817-446a-8482-c3d7a3403800';
    const tab = new Tab({
      id: '22222222-2222-4222-8222-222222222222',
      pointer: `dock/agentic_process-${processId}`,
      target_type: 'agentic_process',
      target_id: processId,
    });

    expect(tab.dockPointer).toEqual(
      expect.objectContaining({
        viewType: ViewType.SHELL,
        pointer: `agentic_process-${processId}`,
        tabHash: `shell|agentic_process-${processId}`,
      }),
    );
  });

  it('normalizes stale dock/conversation-<id> rows to conversation tabs', () => {
    const conversationId = 'd8942fa1-bcb6-4356-8e7d-e79549ba62d4';
    const tab = new Tab({
      id: '33333333-3333-4333-8333-333333333333',
      pointer: `dock/conversation-${conversationId}`,
      target_type: 'conversation',
      target_id: conversationId,
    });

    expect(tab.dockPointer).toEqual(
      expect.objectContaining({
        viewType: ViewType.CONVERSATION,
        pointer: conversationId,
        tabHash: `conversation|${conversationId}`,
      }),
    );
  });
});

describe('Tab.fromResponse target_remote compatibility', () => {
  it('preserves booleans and clears a cached value when an old server omits it', () => {
    const id = 'ded5ca0c-cf9b-4c21-a012-a772a9fd28ee';
    const base = {
      id,
      pointer: '{"viewType":"conversation","pointer":"remote-test"}',
    };

    const cloud = Tab.fromResponse([{ ...base, target_remote: true }])[0];
    expect(cloud.target_remote).toBe(true);

    const local = Tab.fromResponse([{ ...base, target_remote: false }])[0];
    expect(local).toBe(cloud);
    expect(local.target_remote).toBe(false);

    const legacy = Tab.fromResponse([base])[0];
    expect(legacy).toBe(cloud);
    expect(legacy.target_remote).toBeUndefined();
  });
});
