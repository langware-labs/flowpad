/**
 * Command links (`! cmd`) on every chat interface — xterm, UI chat, Vibe — in every mode and
 * every browser choice. See command_links_all_modes.md.
 *
 * Real app, real backend, real Claude Code: each surface shows one session whose transcript
 * already "said" the commands, running in a real terminal. Clicking "Run in chat" types `! cmd`
 * into that real Claude Code, whose shell mode runs it (Claude may answer, as when the user
 * types it); the command is a script that writes down its `BROWSER`, so every assertion reads
 * what really ran. Only the
 * external terminal is intercepted (it would open a window on the tester's screen), and the
 * browser profile list is routed (it would depend on the tester's own browsers).
 */
import { expect, test, type Browser, type BrowserContext, type Page, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiBase, apiContext } from '../_shared/api';
import { sdkModule } from '../_shared/xterm';
import { openVibe } from '../vibe/_helpers';

const API = apiBase();
const PROFILE = { browser: 'chrome', profile: 'Profile 7' };

let root: string;
let projectId: string;
const seeded: string[] = [];
const seededDirs = new Set<string>();
/** Each seeded process's transcript file. */
const transcripts = new Map<string, string>();

/** The command each form carries: a script that records which form ran, and its BROWSER. */
// Relative: every mode runs in the session folder, and a short line is not word-wrapped by Claude Code.
const cmd = (tag: string) => `! sh mark.sh ${tag}`;

const FORMS = ['line', 'quoted', 'inline'] as const;
type Form = (typeof FORMS)[number];

const turn = () =>
  [
    'Run this in the prompt:',
    '',
    cmd('line'),
    '',
    `Then the recap: you run "${cmd('quoted')}" in the prompt, or \`${cmd('inline')}\`, and tell me.`,
    '',
    'Not a command: ! Important note.',
  ].join('\n');

/** What `mark.sh <tag>` wrote since `since`: one entry per run, its BROWSER as content. */
async function runs(tag: string): Promise<string[]> {
  const files = await readdir(join(root, 'out')).catch(() => [] as string[]);
  return Promise.all(files.filter((f) => f.startsWith(`${tag}-`)).sort().map((f) => readFile(join(root, 'out', f), 'utf8')));
}

async function expectRan(tag: string, before: number, browser: RegExp | '' = ''): Promise<void> {
  await expect.poll(async () => (await runs(tag)).length, { message: `${tag} ran` }).toBeGreaterThan(before);
  const last = (await runs(tag)).at(-1)!;
  if (browser === '') expect(last).toBe('');
  else expect(last).toMatch(browser);
}

/** A stopped Claude session whose transcript holds the turn; it resumes in a real terminal. */
async function seedSession(): Promise<string> {
  const sessionId = randomUUID();
  const dir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
  await mkdir(dir, { recursive: true });
  seededDirs.add(dir);
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: root, sessionId, version: '2.1.119' };
  const user = {
    ...base,
    parentUuid: null,
    uuid: randomUUID(),
    type: 'user',
    timestamp: new Date(Date.now() - 2000).toISOString(),
    message: { role: 'user', content: 'What should I run?' },
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
      content: [{ type: 'text', text: turn() }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
  const transcript = join(dir, `${sessionId}.jsonl`);
  await writeFile(transcript, `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`);
  const rq = await apiContext();
  const proc = await (
    await rq.post(`${API}/api/v1/graph/agentic_process`, {
      data: {
        name: 'command links',
        project_id: projectId,
        workdir: root,
        worker_type: 'claude_code',
        session_id: sessionId,
        status: 'stopped',
        visible: true,
        pty_mode: true,
        process_type: 'chat',
      },
    })
  ).json();
  await rq.dispose();
  seeded.push(proc.data.id);
  transcripts.set(proc.data.id, transcript);
  return proc.data.id;
}

const transcriptRows = async (processId: string) =>
  (await readFile(transcripts.get(processId)!, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; message?: { content?: unknown } });

/** Commands Claude Code ran in its shell mode (each is a `<bash-input>` user entry). */
async function shellInputs(processId: string): Promise<number> {
  return (await transcriptRows(processId)).filter(
    (row) => row.type === 'user' && String(row.message?.content).startsWith('<bash-input>'),
  ).length;
}

// ── The surfaces ──────────────────────────────────────────────────────────────

interface Surface {
  name: string;
  /**
   * The session runs a command in its own shell mode. A terminal view keeps Claude Code
   * interactive; the chat and Vibe views switch it to print mode, which has none — there
   * "Run in chat" is not offered and a click falls back to a Flowpad terminal.
   */
  here: boolean;
  open: (page: Page, processId: string) => Promise<void>;
  /** Forms this surface shows as links. */
  forms: readonly Form[];
  click: (page: Page, form: Form) => Promise<void>;
  rightClick: (page: Page, form: Form) => Promise<void>;
}

const assistantTurn = (page: Page) => page.locator('[data-testid="execution-message"][data-role="assistant"]').last();
const domLink = (page: Page, form: Form): Locator => assistantTurn(page).locator(`[data-link="${cmd(form)}"]`).first();

function domSurface(name: string, open: Surface['open']): Surface {
  return {
    name,
    here: false,
    open,
    forms: FORMS,
    click: (page, form) => domLink(page, form).click(),
    rightClick: (page, form) => domLink(page, form).click({ button: 'right' }),
  };
}

/**
 * The screen point of a form's command in the xterm — on its newest row, which may be Claude Code's
 * echo of an earlier run (`!  sh mark.sh quoted`, two spaces: also a command link).
 */
async function xtermPoint(page: Page, form: Form): Promise<{ x: number; y: number }> {
  const pattern = `!\\s+sh mark\\.sh ${form}`;
  const rows = page.locator('.xterm-rows:visible > div').filter({ hasText: new RegExp(pattern) });
  // Only the rows on screen are drawn: scroll back, as a person would, until the command shows.
  const screen = page.locator('.xterm-screen:visible').last();
  for (let up = 0; (await rows.count()) === 0 && up < 20; up++) {
    await screen.hover();
    await page.mouse.wheel(0, -200);
  }
  const row = rows.last();
  await expect(row).toBeVisible();
  return row.evaluate((element, pattern) => {
    const text = (element.textContent ?? '').replace(/\u00a0/g, ' ');
    let index = text.search(new RegExp(pattern));
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (index >= length) {
        index -= length;
        continue;
      }
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    throw new Error(`no glyph for ${pattern}`);
  }, pattern);
}

const SURFACES: Surface[] = [
  {
    name: 'xterm',
    here: true,
    forms: FORMS,
    open: async (page, processId) => {
      await page.goto(`/dock/shell/agentic_process-${processId}?viewMode=advanced`);
      await expect(page.locator('.xterm-rows:visible').first()).toContainText('mark.sh line');
    },
    click: async (page, form) => {
      const point = await xtermPoint(page, form);
      await page.mouse.move(point.x, point.y);
      await page.mouse.click(point.x, point.y);
    },
    rightClick: async (page, form) => {
      const point = await xtermPoint(page, form);
      await page.mouse.click(point.x, point.y, { button: 'right' });
    },
  },
  domSurface('UI chat', async (page, processId) => {
    await page.goto(`/dock/shell/agentic_process-${processId}?viewMode=standard`);
    await expect(assistantTurn(page)).toContainText('mark.sh line');
  }),
  domSurface('Vibe', async (page, processId) => {
    await openVibe(page, processId);
    await expect(assistantTurn(page)).toContainText('mark.sh line');
  }),
];

// ── Setup ─────────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'flowpad-cmdlinks-')));
  await writeFile(
    join(root, 'mark.sh'),
    '#!/bin/sh\nd=$(dirname "$0")/out; mkdir -p "$d"; printf %s "$BROWSER" > "$d/$1-$(date +%s)-$$"\n',
  );
  await chmod(join(root, 'mark.sh'), 0o755);
  const rq = await apiContext();
  const project = await (
    await rq.post(`${API}/api/v1/graph/project`, { data: { name: `cmdlinks-${Date.now()}`, fs_storage_mount_path: root } })
  ).json();
  projectId = project.data.id;
  await rq.dispose();
});

test.afterAll(async () => {
  const rq = await apiContext();
  for (const id of seeded) {
    await rq.post(`${API}/api/v1/graph/agentic_process/${id}/stop`).catch(() => undefined);
    await rq.delete(`${API}/api/v1/graph/agentic_process/${id}`).catch(() => undefined);
  }
  await rq.delete(`${API}/api/v1/graph/project/${projectId}`).catch(() => undefined);
  await rq.dispose();
  await rm(root, { recursive: true, force: true });
  if (!process.env.KEEP_SEEDED) for (const dir of seededDirs) await rm(dir, { recursive: true, force: true });
});

async function newPage(browser: Browser, baseURL: string | undefined): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* no storage */
    }
  });
  const page = await context.newPage();
  // The tester's own browsers would make the list depend on the machine: one known profile.
  await page.route('**/api/v1/browser-profiles', (route) =>
    route.fulfill({
      json: {
        status: 'SUCCESS',
        data: { browsers: [{ id: 'chrome', name: 'Google Chrome', profiles: [{ id: PROFILE.profile, name: 'Work', email: 'w@test' }] }] },
      },
    }),
  );
  return { context, page };
}

/** The external terminal's requests, answered here instead of opening a Terminal window. */
function interceptExternal(page: Page): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  void page.route('**/compute_node/*/open-terminal*', async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ json: { status: 'SUCCESS', data: { command: '', cwd: null } } });
  });
  return bodies;
}

const menuItem = (page: Page, id: string) => page.getByTestId(`link-menu-${id}`);

async function chooseBrowser(page: Page, surface: Surface, form: Form, id: string): Promise<void> {
  await surface.rightClick(page, form);
  await menuItem(page, 'command-browser').hover();
  await menuItem(page, `command-browser-${id}`).click();
  await expect(page.getByTestId('link-menu')).toBeHidden();
}

async function pickMode(page: Page, surface: Surface, form: Form, mode: string): Promise<void> {
  await surface.rightClick(page, form);
  await menuItem(page, mode).click();
}

// ── The tests ─────────────────────────────────────────────────────────────────

const PROFILE_RE = new RegExp(`--browser chrome --profile '${PROFILE.profile}'`);

for (const surface of SURFACES) {
  test.describe(surface.name, () => {
    test.describe.configure({ mode: 'serial' });
    let context: BrowserContext;
    let page: Page;
    let external: Array<Record<string, unknown>>;
    let processId: string;
    let surfaceUrl = '';
    const back = async () => {
      if (page.url() !== surfaceUrl) await surface.open(page, processId);
    };

    test.beforeAll(async ({ browser }, info) => {
      ({ context, page } = await newPage(browser, info.project.use.baseURL));
      external = interceptExternal(page);
      processId = await seedSession();
      await surface.open(page, processId);
      surfaceUrl = page.url();
      // The last mode and browser are saved settings: start each surface from their defaults.
      await page.evaluate(async (sdkModule) => {
        const sdk = await import(sdkModule);
        sdk.instancePreferences.set(sdk.PrefKey.COMMAND_LINK_MODE, 'run-here');
        sdk.instancePreferences.set(sdk.PrefKey.COMMAND_LINK_BROWSER, null);
      }, sdkModule);
    });
    test.afterAll(async () => context?.close());

    test('every form is a command link; prose starting with ! is not', async () => {
      for (const form of surface.forms) {
        await surface.rightClick(page, form);
        await expect(page.getByTestId('link-menu')).toContainText(cmd(form).slice(2));
        await page.keyboard.press('Escape');
      }
      if (surface.name !== 'xterm') await expect(assistantTurn(page).locator('[data-link^="! Important"]')).toHaveCount(0);
    });

    test('menu: the command, every mode with the click marked, Browser ▸, Copy command', async () => {
      await surface.rightClick(page, 'line');
      for (const id of ['run-flowpad', 'run-external', 'command-browser', 'copy']) {
        await expect(menuItem(page, id)).toBeVisible();
      }
      if (surface.here) await expect(menuItem(page, 'run-here')).toHaveAttribute('data-default', 'true');
      else {
        await expect(menuItem(page, 'run-here')).toHaveCount(0);
        await expect(menuItem(page, 'run-flowpad')).toHaveAttribute('data-default', 'true');
      }
      await expect(menuItem(page, 'copy')).toHaveText(/Copy command/);
      await page.keyboard.press('Escape');
    });

    test('click runs in chat by default: real Claude Code shell mode runs it, no new tab', async () => {
      if (!surface.here) {
        // Print mode has no shell mode: the same click runs it in a Flowpad terminal instead.
        for (const form of surface.forms) {
          const before = (await runs(form)).length;
          await surface.click(page, form);
          await expect(page).toHaveURL(/\/dock\/shell\/shell-/);
          await expectRan(form, before);
          await back();
        }
        return;
      }
      for (const form of surface.forms) {
        const before = (await runs(form)).length;
        await surface.click(page, form);
        await expectRan(form, before);
        expect(page.url()).toBe(surfaceUrl);
      }
      // Claude Code recorded each as its own shell input, never as a message to the model.
      await expect.poll(() => shellInputs(processId)).toBe(surface.forms.length);
      const asPrompt = (await transcriptRows(processId)).filter(
        (row) => row.type === 'user' && /^!?\s*sh mark\.sh/.test(String(row.message?.content)),
      );
      expect(asPrompt).toEqual([]);
    });

    test('menu: Run in Flowpad terminal runs it in a new terminal tab, and becomes the click', async () => {
      const before = (await runs('line')).length;
      await pickMode(page, surface, 'line', 'run-flowpad');
      await expect(page).toHaveURL(/\/dock\/shell\/shell-/);
      await expectRan('line', before);
      await back();
      const next = (await runs('quoted')).length;
      await surface.click(page, 'quoted');
      await expect(page).toHaveURL(/\/dock\/shell\/shell-/);
      await expectRan('quoted', next);
      await back();
      await surface.rightClick(page, 'line');
      await expect(menuItem(page, 'run-flowpad')).toHaveAttribute('data-default', 'true');
      await page.keyboard.press('Escape');
    });

    test('menu: Run in external terminal opens one on this machine, in the session folder', async () => {
      external.length = 0;
      await pickMode(page, surface, 'line', 'run-external');
      await expect.poll(() => external.length).toBe(1);
      expect(external[0]).toEqual({ command: `sh mark.sh line`, cwd: root });
      expect(page.url()).toBe(surfaceUrl);
    });

    test('Browser ▸ profile reaches every mode as BROWSER; System default leaves it out', async () => {
      await chooseBrowser(page, surface, 'line', `${PROFILE.browser}-${PROFILE.profile}`);
      let before = 0;
      if (surface.here) {
        before = (await runs('inline')).length;
        await pickMode(page, surface, 'inline', 'run-here');
        await expectRan('inline', before, PROFILE_RE);
      }
      // run-flowpad
      before = (await runs('line')).length;
      await pickMode(page, surface, 'line', 'run-flowpad');
      await expectRan('line', before, PROFILE_RE);
      await back();
      // run-external
      external.length = 0;
      await pickMode(page, surface, 'line', 'run-external');
      await expect.poll(() => external.length).toBe(1);
      expect(external[0]).toEqual({ command: `sh mark.sh line`, cwd: root, browser: PROFILE });
      // System default
      await chooseBrowser(page, surface, 'line', 'default');
      before = (await runs('quoted')).length;
      await pickMode(page, surface, 'quoted', surface.here ? 'run-here' : 'run-flowpad');
      await expectRan('quoted', before, '');
      await back();
    });

    test('Copy command copies it without the !', async () => {
      // The form run last: on a terminal it is still on screen.
      await surface.rightClick(page, 'quoted');
      await menuItem(page, 'copy').click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('sh mark.sh quoted');
    });
  });
}
