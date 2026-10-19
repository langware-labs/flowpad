/**
 * Every link kind, on every surface that shows text, in every mode — one link layer
 * (`lib/link-kind` → `components/links/link-actions` → `link-handlers`). See links_all_modes.md.
 *
 * Real app, real backend, no model: each chat is a stopped session seeded from a Claude
 * transcript whose assistant turn carries every link kind (`seedChat`), so the agent has
 * "said" every link kind before the page opens.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiBase, apiContext } from '../_shared/api';
import { clickPrintedLink, printLink, printedLinkPoint, sdkModule } from '../_shared/xterm';
import { openVibe } from '../vibe/_helpers';

const API = apiBase();
/** A solid red 4×4 PNG, so the lightbox has real bytes to show. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP47+AARwzEcQB6ohfxQHZOgQAAAABJRU5ErkJggg==',
  'base64',
);

let root: string;
let server: Server;
let origin: string;
let appOrigin: string;
let projectId: string;
let processId: string;
let conversationUrl = '';

// ── The link kinds ────────────────────────────────────────────────────────────

interface Kind {
  key: string;
  /** How the kind is written in the turn (markdown). */
  text: () => string;
  /** The link the layer detects. Null: must NOT be a link. */
  link: () => string | null;
  /** Resolves against a working directory, so only a surface that has one shows it. */
  relative?: boolean;
  /** Markdown syntax; a terminal or a plain-text message shows it verbatim. */
  markdown?: boolean;
  media?: boolean;
  /** What a click must have put on screen. */
  landed: (page: Page) => Promise<void>;
}

const editorText = (page: Page, text: string) => expect(page.getByText(text, { exact: false }).first()).toBeVisible();
const urlHas = (page: Page, pattern: RegExp) => expect(page).toHaveURL(pattern);
let currentPage: Page;
const pageUrl = () => currentPage.url();

const KINDS: Kind[] = [
  {
    key: 'k01',
    text: () => `${origin}/page`,
    link: () => `${origin}/page`,
    landed: (page) =>
      expect(page.frameLocator('[data-testid="web-url-frame"]').getByRole('heading')).toHaveText('Web link content'),
  },
  {
    key: 'k02',
    text: () => `${appOrigin}/dock/preferences/appearance`,
    link: () => `${appOrigin}/dock/preferences/appearance`,
    landed: (page) => urlHas(page, /preferences\/appearance/),
  },
  {
    key: 'k03',
    text: () => `${root}/abs.txt`,
    link: () => `${root}/abs.txt`,
    landed: (page) => editorText(page, 'absolute fixture'),
  },
  {
    key: 'k04',
    text: () => 'notes.md',
    link: () => 'notes.md',
    relative: true,
    landed: (page) => editorText(page, 'link fixture notes'),
  },
  {
    key: 'k05',
    text: () => 'code.py:12:3',
    link: () => 'code.py:12:3',
    relative: true,
    landed: (page) => urlHas(page, /code\.py.*line=12/),
  },
  {
    key: 'k06',
    text: () => 'code.py#L7',
    link: () => 'code.py#L7',
    relative: true,
    landed: (page) => urlHas(page, /code\.py.*line=7/),
  },
  {
    key: 'k07',
    text: () => `file://${root}/abs.txt`,
    link: () => `file://${root}/abs.txt`,
    landed: (page) => editorText(page, 'absolute fixture'),
  },
  {
    key: 'k08',
    text: () => './plain-folder',
    link: () => './plain-folder',
    relative: true,
    landed: (page) => editorText(page, 'inside.txt'),
  },
  {
    key: 'k09',
    text: () => `${root}/abs-folder`,
    link: () => `${root}/abs-folder`,
    landed: (page) => editorText(page, 'deep.txt'),
  },
  {
    key: 'k10',
    text: () => '.claude/skills/link-probe',
    link: () => '.claude/skills/link-probe',
    relative: true,
    landed: (page) => urlHas(page, /skill/),
  },
  {
    key: 'k11',
    text: () => `project-${projectId}`,
    link: () => `project-${projectId}`,
    // The path ENDS at the project page: a chat's scope query and a vibe Display path both carry the id.
    landed: () => expect.poll(() => new URL(pageUrl()).pathname).toMatch(new RegExp(`project/${projectId}$`)),
  },
  {
    key: 'k12',
    text: () => `${root}/shot.png`,
    link: () => `${root}/shot.png`,
    media: true,
    landed: (page) => expect(page.getByTestId('media-lightbox')).toBeVisible(),
  },
  {
    key: 'k13',
    text: () => '[the notes](notes.md)',
    link: () => 'notes.md',
    relative: true,
    markdown: true,
    landed: (page) => editorText(page, 'link fixture notes'),
  },
  {
    key: 'k14',
    text: () => `[code at five](${root}/code.py#L5)`,
    link: () => `${root}/code.py#L5`,
    markdown: true,
    landed: (page) => urlHas(page, /code\.py.*line=5/),
  },
  {
    key: 'k15',
    text: () => '`code.py:3`',
    link: () => 'code.py:3',
    relative: true,
    landed: (page) => urlHas(page, /code\.py.*line=3/),
  },
  {
    key: 'k16',
    text: () => 'ראו ב-notes.md עכשיו',
    link: () => 'notes.md',
    relative: true,
    landed: (page) => editorText(page, 'link fixture notes'),
  },
  { key: 'k17', text: () => '`/dock/...`', link: () => null, landed: async () => undefined },
];

/** The turn: one list item per kind, each tagged with its key so a test finds its own. */
const turnFor = (kinds: Kind[]) => ['Links:', '', ...kinds.map((kind) => `- ${kind.key} ${kind.text()}`)].join('\n');

// ── The surfaces ──────────────────────────────────────────────────────────────

interface Surface {
  name: string;
  /** Shows relative links (has a working directory to resolve them in). */
  relative: boolean;
  /** Renders markdown. */
  markdown: boolean;
  /** Its click shows in the vibe Display instead of opening a tab. */
  vibe?: boolean;
  /** Has a process, so the menu offers Vibe (or Show in Display). */
  host: boolean;
  open: (page: Page, kinds: Kind[]) => Promise<void>;
  /** Where the kind's text sits, for the detection check; null for a terminal. */
  item: ((page: Page, kind: Kind) => ReturnType<Page['locator']>) | null;
  click: (page: Page, kind: Kind) => Promise<void>;
  rightClick: (page: Page, kind: Kind) => Promise<void>;
  /** Back to the surface after a click navigated away. */
  reopen: (page: Page) => Promise<void>;
}

/** A chat turn's list item of a kind — the last turn that has it, the agent's echo. */
const listItem = (page: Page, kind: Kind) => page.locator('li', { hasText: kind.key }).last();
/** A plain-text message has no list: the message bubble is the item. */
const bubble = (page: Page) => page.locator('[data-testid^="message-bubble-"]').last();

function domSurface(
  name: string,
  opts: Omit<Surface, 'name' | 'click' | 'rightClick' | 'item'> & { item?: Surface['item'] },
): Surface {
  const item = opts.item ?? listItem;
  const link = (page: Page, kind: Kind) => item(page, kind).locator(`[data-link="${kind.link()}"]`).first();
  return {
    name,
    ...opts,
    item,
    click: (page, kind) => link(page, kind).click(),
    rightClick: (page, kind) => link(page, kind).click({ button: 'right' }),
  };
}

/** Transcript folders this run wrote under the Claude config dir, removed after. */
const seededDirs = new Set<string>();

/**
 * A stopped chat whose transcript already holds `text` as the agent's answer — where the
 * backend's Claude session lookup scans (`$CLAUDE_CONFIG_DIR/projects/<cwd>`), as
 * `navigation/_world.ts` `createLongChat` does.
 */
async function seedChat(text: string, extra: Record<string, unknown> = {}): Promise<string> {
  const sessionId = randomUUID();
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    'projects',
    root.replace(/[^A-Za-z0-9]/g, '-'),
  );
  await mkdir(dir, { recursive: true });
  seededDirs.add(dir);
  const base = {
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: root,
    sessionId,
    version: '2.1.119',
  };
  const user = {
    ...base,
    parentUuid: null,
    uuid: randomUUID(),
    type: 'user',
    timestamp: new Date(Date.now() - 2000).toISOString(),
    message: { role: 'user', content: 'List every link kind.' },
  };
  const assistant = {
    ...base,
    parentUuid: user.uuid,
    uuid: randomUUID(),
    type: 'assistant',
    timestamp: new Date(Date.now() - 1000).toISOString(),
    message: {
      id: `msg_${sessionId}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
  await writeFile(join(dir, `${sessionId}.jsonl`), `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`);
  const rq = await apiContext();
  const proc = await (
    await rq.post(`${API}/api/v1/graph/agentic_process`, {
      data: {
        name: 'links chat',
        project_id: projectId,
        workdir: root,
        worker_type: 'claude_code',
        session_id: sessionId,
        status: 'stopped',
        visible: true,
        pty_mode: false,
        process_type: 'chat',
        ...extra,
      },
    })
  ).json();
  await rq.dispose();
  seededProcesses.push(proc.data.id);
  return proc.data.id;
}
const seededProcesses: string[] = [];

let shellId = '';
async function openTerminal(page: Page, mode: 'advanced' | 'dev', kinds: Kind[]): Promise<void> {
  await page.goto(`/dock/shell/new_terminal?viewMode=${mode}`);
  await expect(page).toHaveURL(/\/dock\/shell\/shell-/);
  shellId = new URL(page.url()).pathname
    .split('/')
    .pop()!
    .replace(/^shell-/, '');
  await page.evaluate(
    async ({ sdkModule, shellId, command }) => {
      const sdk = await import(sdkModule);
      await (await sdk.Shell.getById(shellId)).sendInput(command);
    },
    { sdkModule, shellId, command: `cd '${root}'\n` },
  );
  for (const kind of kinds) await printLink(page, shellId, kind.text().replace(/`/g, ''));
}

function terminalSurface(mode: 'advanced' | 'dev'): Surface {
  let url = '';
  return {
    name: `terminal (${mode})`,
    item: null,
    relative: true,
    markdown: false,
    host: false,
    open: async (page, kinds) => {
      await openTerminal(page, mode, kinds);
      url = page.url();
    },
    click: (page, kind) => clickPrintedLink(page, kind.link()!),
    rightClick: async (page, kind) => {
      const point = await printedLinkPoint(page, kind.link()!);
      await page.mouse.click(point.x, point.y, { button: 'right' });
    },
    reopen: async (page) => {
      await page.goto(url);
      await expect(page.locator('.xterm-rows:visible').first()).toContainText('abs.txt');
    },
  };
}

async function openAssistant(page: Page): Promise<void> {
  const chat = page.getByTestId('assistant-chat');
  // The panel remembers it was open and comes back on its own after a load; clicking
  // before it does would toggle it shut.
  const reopened = await chat.waitFor({ state: 'visible', timeout: 3_000 }).then(
    () => true,
    () => false,
  );
  if (!reopened) await page.getByTestId('flowpad-assistant-button').click();
  await expect(chat.locator('[data-testid="execution-message"][data-role="assistant"]').last()).toContainText('k01');
}

const assistantTurn = (page: Page) => page.locator('[data-testid="execution-message"][data-role="assistant"]').last();

const SURFACES: Surface[] = [
  terminalSurface('advanced'),
  terminalSurface('dev'),
  domSurface('chat (standard)', {
    relative: true,
    markdown: true,
    host: true,
    open: async (page, kinds) => {
      processId = await seedChat(turnFor(kinds));
      await page.goto(`/dock/shell/agentic_process-${processId}?viewMode=standard`);
      await expect(assistantTurn(page)).toContainText('k01');
    },
    reopen: async (page) => {
      await page.goto(`/dock/shell/agentic_process-${processId}?viewMode=standard`);
      await expect(assistantTurn(page)).toContainText('k01');
    },
  }),
  domSurface('chat (vibe)', {
    relative: true,
    markdown: true,
    host: true,
    vibe: true,
    open: async (page, kinds) => {
      processId = await seedChat(turnFor(kinds));
      await openVibe(page, processId);
      await expect(assistantTurn(page)).toContainText('k01');
    },
    reopen: async (page) => {
      await openVibe(page, processId);
      await expect(assistantTurn(page)).toContainText('k01');
    },
  }),
  domSurface('assistant (floating)', {
    relative: true,
    markdown: true,
    host: true,
    open: async (page, kinds) => {
      await page.goto('/dock/automations');
      await page.getByTestId('flowpad-assistant-button').click();
      const chat = page.getByTestId('assistant-chat');
      await expect(chat).toBeVisible();
      // The assistant shows the newest chat of ITS project for THIS page's context.
      await expect(chat).toHaveAttribute('data-context-key', /.+/);
      const contextKey = await chat.getAttribute('data-context-key');
      const rq = await apiContext();
      const assistant = await (await rq.get(`${API}/api/v1/graph/project/@flowpad_assistant`)).json();
      await rq.dispose();
      processId = await seedChat(turnFor(kinds), {
        target_typeid_str: `project-${assistant.data.id}`,
        context_key: contextKey,
      });
      await page.reload();
      await openAssistant(page);
    },
    reopen: async (page) => {
      await page.goto('/dock/automations');
      await openAssistant(page);
    },
  }),
  domSurface('conversation message', {
    relative: false,
    markdown: false,
    host: false,
    item: (page) => bubble(page),
    open: async (page, kinds) => {
      const rq = await apiContext();
      const created = await (
        await rq.post(`${API}/api/v1/graph/conversation`, { data: { title: `links-${Date.now()}` } })
      ).json();
      await rq.dispose();
      conversationUrl = `/dock/conversation/${created.data.id}`;
      await page.goto(conversationUrl);
      await page.getByPlaceholder(/Reply to/).click();
      for (const [i, line] of turnFor(kinds).split('\n').entries()) {
        if (i > 0) await page.keyboard.press('Shift+Enter');
        await page.keyboard.insertText(line);
      }
      await page.keyboard.press('Enter');
      await expect(bubble(page)).toContainText('k01');
    },
    reopen: async (page) => {
      await page.goto(conversationUrl);
      await expect(bubble(page)).toContainText('k01');
    },
  }),
];

// ── The tests ─────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'flowpad-links-')));
  await writeFile(
    join(root, 'code.py'),
    Array.from({ length: 20 }, (_, i) => `line_${i + 1} = ${i + 1}`).join('\n') + '\n',
  );
  await writeFile(join(root, 'notes.md'), '# Notes\n\nlink fixture notes\n');
  await writeFile(join(root, 'abs.txt'), 'absolute fixture\n');
  await writeFile(join(root, 'shot.png'), PNG);
  await mkdir(join(root, 'plain-folder'));
  await writeFile(join(root, 'plain-folder', 'inside.txt'), 'inside\n');
  await mkdir(join(root, 'abs-folder'));
  await writeFile(join(root, 'abs-folder', 'deep.txt'), 'deep\n');
  const skill = join(root, '.claude', 'skills', 'link-probe');
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, 'SKILL.md'),
    '---\nname: link-probe\ndescription: Link fixture skill\n---\n# Link probe\n',
  );

  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Link fixture</title><h1>Web link content</h1>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  origin = `http://127.0.0.1:${address.port}`;

  const rq = await apiContext();
  const project = await (
    await rq.post(`${API}/api/v1/graph/project`, { data: { name: `links-${Date.now()}`, fs_storage_mount_path: root } })
  ).json();
  projectId = project.data.id;
  // Index the skill folder, as a real session's walk would have, so its link opens the skill.
  await rq.post(`${API}/api/v1/graph/project/${projectId}/resolve-display-target`, {
    data: { link: join(skill, 'SKILL.md') },
  });
  await rq.dispose();
});

test.afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  const rq = await apiContext();
  for (const id of seededProcesses) await rq.delete(`${API}/api/v1/graph/agentic_process/${id}`).catch(() => undefined);
  await rq.delete(`${API}/api/v1/graph/project/${projectId}`).catch(() => undefined);
  await rq.dispose();
  await rm(root, { recursive: true, force: true });
  for (const dir of seededDirs) await rm(dir, { recursive: true, force: true });
});

async function newPage(
  browser: Browser,
  baseURL: string | undefined,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* no storage */
    }
  });
  return { context, page: await context.newPage() };
}

const displayRe = () =>
  new RegExp(`/process/agentic_process-${processId}/display/|host=agentic_process-${processId}.*activeDisplay=1`);

/**
 * The newest Display history entry's stamp, as the server keeps it. A show always moves
 * it: a new target is pushed, the same target shown again refreshes its stamp.
 */
async function lastShownAt(): Promise<string> {
  const rq = await apiContext();
  const body = await (await rq.get(`${API}/api/v1/graph/agentic_process/${processId}`)).json();
  await rq.dispose();
  return String((body.data.context_data?.display_stack ?? []).at(-1)?.shown_at ?? '');
}

for (const surface of SURFACES) {
  test.describe(surface.name, () => {
    test.describe.configure({ mode: 'serial' });
    let context: BrowserContext;
    let page: Page;
    let popups = 0;
    const kinds = KINDS.filter((kind) => (surface.relative || !kind.relative) && (surface.markdown || !kind.markdown));

    test.beforeAll(async ({ browser }, info) => {
      appOrigin = String(info.project.use.baseURL);
      ({ context, page } = await newPage(browser, info.project.use.baseURL));
      currentPage = page;
      page.on('popup', () => popups++);
      await surface.open(page, kinds);
    });
    test.afterAll(async () => {
      await context?.close();
    });

    test('detects exactly the links, and nothing that is not one', async () => {
      test.skip(surface.item === null, 'a terminal has no DOM links; each click below proves detection');
      for (const kind of kinds) {
        const item = surface.item!(page, kind);
        const link = kind.link();
        if (link) await expect(item.locator(`[data-link="${link}"]`)).toHaveCount(1);
        else await expect(item.locator('[data-link^="/dock"]')).toHaveCount(0);
      }
      // No link in a chat is a browser link: the layer follows it, never the browser.
      await expect(page.locator('a[data-link][target="_blank"]')).toHaveCount(0);
    });

    for (const kind of KINDS) {
      test(`click ${kind.key}`, async () => {
        test.skip(!kinds.includes(kind) || kind.link() === null, 'not shown on this surface');
        const before = surface.vibe ? await lastShownAt() : '';
        const opened = popups;
        await surface.click(page, kind);
        await kind.landed(page);
        if (surface.vibe && !kind.media) {
          // The active Display, in either address form (project-placed, or hosted with `activeDisplay`).
          await expect(page).toHaveURL(displayRe());
          await expect.poll(lastShownAt).not.toBe(before);
        }
        expect(popups, 'a click never opens a browser tab').toBe(opened);
        if (kind.media) await page.keyboard.press('Escape');
        await surface.reopen(page);
      });
    }

    test('right-click menu lists exactly the actions for this surface', async () => {
      const code = kinds.find((kind) => kind.key === 'k05') ?? kinds.find((kind) => kind.key === 'k03')!;
      await surface.rightClick(page, code);
      const menu = page.getByTestId('link-menu');
      await expect(menu).toBeVisible();
      const expected = surface.vibe
        ? ['copy', 'show-in-display', 'open', 'browser']
        : surface.host
          ? ['copy', 'open', 'vibe', 'browser']
          : ['copy', 'open', 'browser'];
      const items = await menu
        .locator('[data-testid^="link-menu-"]')
        .evaluateAll((els) =>
          els
            .map((el) => el.getAttribute('data-testid')!.replace('link-menu-', ''))
            .filter((id) => !id.startsWith('profile') && id !== 'open-in'),
        );
      expect(items).toEqual(expected);
      await page.keyboard.press('Escape');
    });

    test('menu: Copy puts the link on the clipboard', async () => {
      // abs-folder: no other printed link contains it (a terminal row is found by its text).
      const kind = kinds.find((k) => k.key === 'k09')!;
      await surface.rightClick(page, kind);
      await page.getByTestId('link-menu-copy').click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(kind.link());
    });

    test('menu: Open in Flowpad opens it as a tab', async () => {
      const kind = kinds.find((k) => k.key === 'k03')!;
      await surface.rightClick(page, kind);
      const before = surface.vibe ? await lastShownAt() : '';
      await page.getByTestId('link-menu-open').click();
      await kind.landed(page);
      // A tab of its own: in vibe it is a child tab beside the Display, never a Display history entry.
      if (surface.vibe) expect(await lastShownAt()).toBe(before);
      await surface.reopen(page);
    });

    test('menu: Vibe / Show in Display', async () => {
      test.skip(!surface.host, 'no process to show it in');
      const kind = kinds.find((k) => k.key === 'k03')!;
      await surface.rightClick(page, kind);
      await page.getByTestId(surface.vibe ? 'link-menu-show-in-display' : 'link-menu-vibe').click();
      await kind.landed(page);
      await expect(page).toHaveURL(/viewMode=vibe|\/display\//);
      await surface.reopen(page);
    });

    test('menu: Open in browser opens the Flowpad address of a file, and a web page as itself', async () => {
      const file = kinds.find((k) => k.key === 'k03')!;
      await surface.rightClick(page, file);
      let popup = page.waitForEvent('popup');
      await page.getByTestId('link-menu-browser').click();
      const filePage = await popup;
      await expect(filePage).toHaveURL(/abs\.txt/);
      await filePage.close();
      const web = kinds.find((k) => k.key === 'k01')!;
      await surface.rightClick(page, web);
      popup = page.waitForEvent('popup');
      await page.getByTestId('link-menu-browser').click();
      const webPage = await popup;
      await expect(webPage).toHaveURL(`${origin}/page`);
      await webPage.close();
    });

    test('menu: Open in ▸ a browser profile hands the link to that profile', async () => {
      const opened: string[] = [];
      await page.route('**/api/v1/browser-profiles', (route) =>
        route.fulfill({
          json: {
            status: 'SUCCESS',
            data: {
              browsers: [
                { id: 'chrome', name: 'Google Chrome', profiles: [{ id: 'Work', name: 'Work', email: null }] },
              ],
            },
          },
        }),
      );
      await page.route('**/api/v1/browser-profiles/open', async (route) => {
        opened.push(String(route.request().postDataJSON().url));
        await route.fulfill({ json: { status: 'SUCCESS', data: {} } });
      });
      const web = kinds.find((k) => k.key === 'k01')!;
      await surface.rightClick(page, web);
      await page.getByTestId('link-menu-open-in').hover();
      await page.getByTestId('link-menu-profile-chrome-Work').click();
      await expect.poll(() => opened).toEqual([`${origin}/page`]);
      await page.unrouteAll();
    });
  });
}
