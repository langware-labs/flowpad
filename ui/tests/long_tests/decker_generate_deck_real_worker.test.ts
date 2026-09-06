/**
 * decker generate-a-deck, end to end with a REAL agent (vitest long tier).
 *
 * A real Claude worker, with the flowpad_assistant skills available (global
 * default), is asked to use the `decker` skill to generate a small deck from a
 * pre-seeded template. Asserts the full stitch:
 *   - the agent assembles the self-contained deck HTML under assets/decks/<name>/
 *   - discovering that folder mints a `deck` entity (the walker + extractor run)
 *
 * A template is pre-seeded (the shipped scaffold copied into the workdir) so the
 * turn only exercises deck GENERATION, keeping it inside the real-Claude cap.
 *
 * Spawns its OWN isolated backend (fresh instance + port) — never touches a
 * running dev/prod instance. Requires Claude Code installed + authed; skips on
 * API-limit via the content probe. Models `reindex_flow_real_worker.test.ts`.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSdkRealm } from '../_sdk_realm';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCAFFOLD = path.join(
  REPO_ROOT,
  'flow_sdk/system_projects/flowpad_assistant/.claude/skills/decker/template',
);
const INSTANCE = process.env.TEST_INSTANCE || 'deckergen';
const PORT = Number(process.env.TEST_PORT || 6088);

let proc: ChildProcess | undefined;
let sdk: any;
let disposeSdkRealm: (() => void) | undefined;
let tmpRoot = '';
let systemTools: any;
let TypeId: any;

async function waitHealthy(port: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/api/v1/health/status`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function isClaudeUnavailable(content: string): boolean {
  return /(hit your limit|weekly limit|usage limit|rate limit|quota|too many requests|overloaded)/i.test(content);
}

function chatContent(outputs: any[], FlowElementTypes: any): string {
  return outputs
    .filter((o) => o.elementType === FlowElementTypes.CHAT || o.elementType === FlowElementTypes.TEXT)
    .map((o) => String(o.data ?? ''))
    .join('');
}

/** Recursively collect *.html files under a dir (excluding *.mcp.html). */
async function findDeckHtml(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries: any[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.html') && !e.name.endsWith('.mcp.html')) out.push(p);
    }
  }
  await walk(root);
  return out;
}

beforeAll(async () => {
  const logPath = `/tmp/decker_generate_deck_real_worker.${INSTANCE}.log`;
  const logHandle = await fs.open(logPath, 'w');
  try {
    proc = spawn('uv', ['run', '-m', 'flow_sdk.server.run'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        FLOW_INSTANCE: INSTANCE,
        LOCAL_SERVER_PORT: String(PORT),
        MINIHUB_RELOAD: 'False',
        FLOWPAD_SKIP_DOTENV: 'true',
        FLOWPAD_SKIP_LOCK: 'true',
        FLOWPAD_DEFAULT_WORKER: 'claude',
      },
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    });
  } finally {
    await logHandle.close();
  }
  const up = await waitHealthy(PORT, 60_000);
  if (!up) throw new Error(`backend '${INSTANCE}' did not come up on :${PORT} — see ${logPath}`);

  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'decker-gen-')));

  const realm = await createSdkRealm(`http://localhost:${PORT}`);
  sdk = realm.sdk;
  disposeSdkRealm = realm.dispose;
  const info = await sdk.dataManager.bootstrap('localhost', true);
  await sdk.dataManager.loadTypes(info.types || []);
  systemTools = sdk.systemTools;
  TypeId = sdk.TypeId;

  const cm = sdk.ConnectionManager.getInstance();
  if (!cm.connected) await cm.connect();
}, 90_000);

afterAll(async () => {
  disposeSdkRealm?.();
  proc?.kill('SIGTERM');
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe('decker — real agent generates a deck from a template → deck entity', () => {
  it('assembles the deck HTML and the folder discovers as a deck entity', async (context: any) => {
    const workdir = path.join(tmpRoot, 'proj');
    // Pre-seed a template so the turn only does deck generation (bounded).
    const tplDir = path.join(workdir, 'assets', 'deck-templates', 'basic');
    await fs.mkdir(path.dirname(tplDir), { recursive: true });
    await fs.cp(SCAFFOLD, tplDir, { recursive: true });

    const worker = await new sdk.AgenticProcess({ workdir, visible: false, pty_mode: false }).save([]);
    await worker.watch();
    await worker.prompt(
      'Use the decker skill to generate a SMALL 2-slide deck from the existing ' +
        "'basic' template (assets/deck-templates/basic): a cover-centered slide " +
        "titled 'Coffee' and a closing-centered slide titled 'Thanks'. Write it to " +
        'assets/decks/coffee/ (deck.json + the assembled coffee.html via ' +
        'tools/build_deck.py), then index the project root. Keep it minimal.',
    );

    const chat = chatContent(worker.flowDataStream.items, sdk.FlowElementTypes);
    if (isClaudeUnavailable(chat)) context.skip(`Claude unavailable: ${chat.slice(0, 200)}`);

    // The agent must have assembled a deck HTML under assets/decks/.
    const decksDir = path.join(workdir, 'assets', 'decks');
    const htmls = await findDeckHtml(decksDir);
    console.log('[decker-gen] chat:', chat.slice(0, 300));
    console.log('[decker-gen] deck htmls:', htmls);
    expect(htmls.length, 'agent must assemble a deck HTML under assets/decks/').toBeGreaterThan(0);

    // The deck folder must discover as a `deck` entity (walker + extractor run).
    const deckDir = path.dirname(htmls[0]);
    const disc = await systemTools.resolveByPath(deckDir);
    expect(disc?.type, 'deck folder must classify as a deck').toBe('deck');
    expect(disc?.id, 'deck folder must mint a deck entity').toBeTruthy();
    const entity: any = await sdk.dataManager.getByTypeId(new TypeId('deck', disc!.id)).catch(() => null);
    expect(entity, 'deck entity must be fetchable').toBeTruthy();
    expect(entity.num_slides, 'deck should record its slide count').toBeGreaterThan(0);
  }, 240_000);
});
