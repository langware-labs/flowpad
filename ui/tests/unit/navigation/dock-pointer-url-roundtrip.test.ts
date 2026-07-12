import { describe, expect, it } from 'vitest';
import { Layout, TypeId, ViewType } from '@sdk';
import { projectScope } from '@src/lib/scope-filter';
import { DockPointer } from '@src/navigation/DockPointer';

const LAYOUTS = [Layout.DOCK, Layout.DEV, Layout.WIN] as const;
const BASE_PATHS = [
  '/',
  '/agent/agent-123',
  '/agent/agent-123/flow/flow-456',
  '/agent/agent-123/flow/flow-456/dock/project/stale-project',
] as const;

const U = (seed: string) => `${seed.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-000000000000`;

function expectRootUrlRoundTrip(pointer: DockPointer): void {
  const url = pointer.toUrl();
  const rebuiltUrl = DockPointer.fromUrl(url).toUrl();
  expect(
    rebuiltUrl,
    `Expected ${pointer.toString()} to satisfy pointer.toUrl() === DockPointer.fromUrl(pointer.toUrl()).toUrl()`,
  ).toBe(url);
}

function expectBaseUrlRoundTrip(pointer: DockPointer, currentPath: string): void {
  const url = pointer.toUrl(currentPath);
  const rebuiltUrl = DockPointer.fromUrl(url).toUrl(url);
  expect(
    rebuiltUrl,
    `Expected ${pointer.toString()} to round-trip under base path ${currentPath}`,
  ).toBe(url);
}

function seededRandom(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, values: readonly T[]): T {
  return values[Math.floor(rand() * values.length)];
}

const SEGMENTS = [
  'alpha',
  'with space',
  'q?x=1',
  'hash#part',
  'percent%value',
  'plus+equals=amp&',
  'semi;colon',
  'paren(value)',
  'at@local',
  'dots..',
  'encoded%2Fslash',
] as const;

const OPTION_KEYS = ['slot', 'q', 'message', 'filter', 'scope', 'selected', 'cwd', 'startCommand'] as const;
const OPTION_VALUES = [
  'tab',
  'activeView',
  'simple',
  'with space',
  'a+b & c=d',
  'hash#fragment',
  'path/with/slash',
  'percent%value',
  '',
] as const;

function randomPointer(rand: () => number, index: number): string | undefined {
  if (index === 0) return undefined;

  const depth = 1 + Math.floor(rand() * 4);
  const pointer = Array.from({ length: depth }, () => pick(rand, SEGMENTS)).join('/');

  if (index % 5 === 1) return `/${pointer}`;
  if (index % 5 === 2) return `compute_node-@local/${pointer}`;
  if (index % 5 === 3) return `agentic_process-${U(String(index))}/${pointer}`;
  return pointer;
}

function randomOptions(rand: () => number, index: number): Record<string, string> | undefined {
  if (index % 4 === 0) return undefined;

  const count = 1 + Math.floor(rand() * 4);
  const options: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) {
    options[pick(rand, OPTION_KEYS)] = pick(rand, OPTION_VALUES);
  }
  return options;
}

function representativePointers(): DockPointer[] {
  const agenticProcess = new TypeId('agentic_process', U('a11ce'));
  const markdown = new TypeId('markdown', U('b00c'));
  const conversation = U('c0ffee');
  const project = U('1234');

  return [
    DockPointer.forTab(ViewType.HOME),
    DockPointer.forHome('projects', project, { scope: 'project', project: 'project with spaces', expand: true }),
    DockPointer.forSystemProfile('sessions', agenticProcess.toString(), { scope: 'global' }),
    DockPointer.forShell(agenticProcess.toString(), {
      cwd: '/Users/me/project with spaces',
      startCommand: 'echo ready && pwd',
      skipPermissions: true,
    }),
    DockPointer.forFile('/Users/me/src/main file.ts', { line: 12, column: 4 }, Layout.WIN),
    DockPointer.forFs('/Users/me/src/app.ts'),
    DockPointer.forPlan(agenticProcess, '/Users/me/plans/loader plan.md'),
    DockPointer.forAssetList('skill', { scope: projectScope(project) }),
    DockPointer.forAssetFolder('markdown', 'compute_node-@local', 'docs/plans & notes', Layout.DEV),
    DockPointer.forAssetEditor('markdown', '/Users/me/project docs/read me.md', Layout.WIN, {
      editorMode: 'learning',
      anchor: 'section#1',
    }),
    DockPointer.forAssetEditorByTypeId('markdown', markdown, Layout.DOCK, {
      mode: 'preview',
      from: 'search?q=abc',
    }),
    DockPointer.forWiki('Plan A / Research? yes', Layout.DEV, '@local'),
    DockPointer.forProject(project, { roomId: U('5678'), tab: agenticProcess }),
    DockPointer.forProject(project, { conversationId: conversation }, Layout.WIN),
    DockPointer.forInbox({ conversationId: conversation, messageId: U('feed') }),
    DockPointer.forConversation(conversation, { messageId: U('babe') }, Layout.WIN),
    DockPointer.forTasks(U('a1fa'), { conversationId: conversation, layout: Layout.DEV }),
    DockPointer.forSearch('release notes closed', {
      record_type: 'skill',
      status: 'active',
      scope: 'project',
      time_preset: 'today',
    }),
    DockPointer.forSettings('auth.github', 'enabled only'),
    DockPointer.forShow('agent-@local', 'page one', 'main/right'),
    DockPointer.forApp('skill-app', 'routes/deep/path', { tab: 'overview', q: 'a+b & c' }),
    DockPointer.forGraph(new TypeId('conversation', conversation), { depth: 3, selected: 'node/a?b#c' }),
    DockPointer.forKnowledgeBrowser('/Users/me/docs/ref.md', 'vfs', { selected: 'heading?x=1#top' }, Layout.WIN),
    DockPointer.forLensTranscript('codex', '/Users/me/.codex/session file.jsonl', Layout.DOCK, {
      t: '2026-06-18T16:00:00Z',
    }),
    new DockPointer(ViewType.WEB_APP, 'webapp-shell', {
      port: '4098',
      url: 'http://localhost:4098/?x=1#frag',
    }),
    new DockPointer(ViewType.MACHINE, 'processes'),
    new DockPointer(ViewType.TRIGGERS, 'trigger/set?name=a+b'),
    new DockPointer(ViewType.CRON, 'cron-job-1'),
  ];
}

describe('DockPointer URL round trip', () => {
  it('round-trips representative DockPointer factories through toUrl/fromUrl/toUrl', () => {
    for (const pointer of representativePointers()) {
      expectRootUrlRoundTrip(pointer);
      for (const basePath of BASE_PATHS) {
        expectBaseUrlRoundTrip(pointer, basePath);
      }
    }
  });

  it('fuzzes every ViewType and layout through toUrl/fromUrl/toUrl', () => {
    const rand = seededRandom(0xdecafbad);
    const pointers: DockPointer[] = [];

    for (const viewType of Object.values(ViewType)) {
      for (const layout of LAYOUTS) {
        for (let i = 0; i < 5; i += 1) {
          pointers.push(new DockPointer(viewType, randomPointer(rand, i), randomOptions(rand, i), layout));
        }
      }
    }

    for (const pointer of pointers) {
      expectRootUrlRoundTrip(pointer);
      expectBaseUrlRoundTrip(pointer, pick(rand, BASE_PATHS));
    }
  });
});
