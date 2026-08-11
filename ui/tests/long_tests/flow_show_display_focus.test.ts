/**
 * SubAgent → `flow show` → AgenticProcess.on_show → entity_event('on_show') → TS 'show' event.
 *
 * End-to-end, no mocks: a real Claude worker is created with standing
 * instructions (context_data.instructions → system-prompt append) telling it to
 * present its deliverable via `flow show`. One turn — "build me hello world
 * app" — the agent writes the app and runs `flow show file <path>` (or
 * `flow show webapp --port N`), the backend `show` action resolves the target
 * and emits the `on_show` entity event, which this test observes through the
 * SDK's typed `proc.onShow(...)` subscription (the same channel a display
 * surface uses). `show` deliberately needs NO active tab — unlike navigate —
 * so no presence frame is sent.
 *
 * The test passes the moment the show event arrives — it does NOT wait for the
 * turn to complete (the show fires mid-turn, right after the deliverable
 * exists). Output is drained only for diagnostics / the Claude-unavailable skip.
 *
 * Requires: running long-test backend with FLOWPAD_DEFAULT_WORKER=claude,
 * restarted with the `show` action + instructions-merge backend changes.
 */

import { AgenticProcess, apiClient, FlowData, FlowElementTypes } from '@sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Resolve a show target's `typeid` the way a display surface does: fetch it. */
async function resolveTypeId(typeid: string): Promise<Record<string, unknown> | null> {
  const [type, ...rest] = typeid.split('-');
  const id = rest.join('-');
  try {
    const res = await apiClient.get<unknown>(`/graph/${type}/${id}`);
    const data = ((res as { data?: unknown })?.data ?? res) as Record<string, unknown>;
    return data && data.id ? data : null;
  } catch {
    return null;
  }
}

/** The id that currently owns `path`, per a fresh `flow show` resolution. */
async function showOwnerId(proc: AgenticProcess, target: string): Promise<string | null> {
  const res = await apiClient.post<unknown>(`/graph/agentic_process/${proc.id}/show`, { path: target });
  const data = ((res as { data?: unknown })?.data ?? res) as { id?: string };
  return data?.id ?? null;
}

const SHOW_INSTRUCTIONS = [
  'Work fast, no explanations, no preamble text.',
  'Exactly two actions: (1) Write the deliverable file. (2) Run via Bash:',
  '  flow show file <absolute-path>',
  'then stop. Run flow show exactly once; exit 0 means done.',
  'Do NOT use `flow navigate`. Do NOT read files, list directories, or verify.',
].join('\n');

function chatContent(outputs: FlowData[]): string {
  return outputs
    .filter((o) => o.elementType === FlowElementTypes.CHAT || o.elementType === FlowElementTypes.TEXT)
    .map((o) => String(o.data ?? ''))
    .join('');
}

function isClaudeUnavailable(content: string): boolean {
  return /(hit your limit|weekly limit|usage limit|rate limit|quota|too many requests|overloaded)/i.test(content);
}

describe('flow show — agent-declared display focus reaches proc.onShow', () => {
  let proc: AgenticProcess | null = null;
  let workdir: string | null = null;

  afterEach(async () => {
    try {
      await proc?.stop?.();
    } catch {
      /* best-effort */
    }
    if (workdir && !process.env.KEEP_WORKDIR) {
      try {
        fs.rmSync(workdir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    proc = null;
    workdir = null;
  });

  it('instructions + "build me hello world app" → on_show payload received', async (context: any) => {
    await apiTestSetup(getTestSignupInfo(), context.task.name);

    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-show-hello-'));

    // 1-2. ap = new AP().save() with the standing show instructions
    //      (context_data.instructions → worker system-prompt append).
    // The worker resolves `flow` from PATH — normally the installed release
    // (~/.local/bin/flow), which may predate `flow show`. Front this repo's
    // venv so the worker runs the CLI under test.
    const venvBin = path.resolve(__dirname, '../../..', '.venv/bin');

    proc = await new AgenticProcess({
      workdir,
      // Headless transport — with the PTY default, `claude -- "<prompt>"` only
      // PRE-FILLS the first prompt (no auto-submit) and the turn never runs.
      pty_mode: false,
      // No assistant mount — the instructions below carry the whole recipe,
      // and skipping the skill scan shaves seconds off claude boot.
      load_flowpad_assistant: false,
      context_data: { instructions: SHOW_INSTRUCTIONS },
      cli_config: {
        permission_mode: 'bypassPermissions',
        // This test exercises the show plumbing, not model quality — haiku
        // keeps the whole turn inside the 30s cap.
        model: 'haiku',
        env_vars: { PATH: `${venvBin}:${process.env.PATH ?? ''}` },
      },
    }).save([]);
    await proc.watch();

    // 4 (armed before 3). Subscribe to the typed 'show' event BEFORE submitting —
    // the show lands mid-turn.
    const received: Record<string, unknown>[] = [];
    let resolveShow!: () => void;
    const showSeen = new Promise<void>((resolve) => {
      resolveShow = resolve;
    });
    proc.onShow((payload) => {
      received.push(payload);
      resolveShow();
    });

    // Drain output for diagnostics only (never awaited to completion — the
    // test must not depend on the turn finishing). Ring-capped: only the tail
    // is ever read (for the failure message), so don't retain a chatty turn.
    const outputs: FlowData[] = [];
    void (async () => {
      try {
        for await (const item of proc.output()) {
          outputs.push(item);
          if (outputs.length > 200) outputs.shift();
        }
      } catch {
        /* stream ends with the process — irrelevant once show is seen */
      }
    })();

    // 3. ap.submit("build me hello world app") — fire the turn, don't wait for it.
    await proc.executeInstruction(
      'build me hello world app (a simple single index.html is fine)',
      { sync: false },
    );

    // 4. wait for the show command — the ONLY await; fail fast with whatever
    //    the agent said so far.
    await Promise.race([
      showSeen,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          const said = chatContent(outputs);
          reject(
            new Error(
              isClaudeUnavailable(said)
                ? `SKIP-WORTHY Claude unavailable: ${said.slice(0, 240)}`
                : `no on_show received; agent said: ${said.slice(0, 400)}`,
            ),
          );
        }, 55_000),
      ),
    ]).catch((e: Error) => {
      if (/SKIP-WORTHY/.test(e.message)) context.skip(e.message);
      throw e;
    });

    expect(received.length, 'expected at least one show payload').toBeGreaterThan(0);
    const payload = received[0];
    expect(payload.kind, 'show payload kind').toMatch(/^(entity|vfs|webapp)$/);
    if (payload.kind === 'webapp') {
      expect(payload.port, 'webapp show carries the port').toBeTruthy();
    } else {
      // entity | vfs — the target must be addressable: a typeid or a path.
      expect(payload.typeid ?? payload.path, 'show target (typeid or path)').toBeTruthy();
    }

    // Entity validation: an `entity` target is opened BY ID — the display
    // surface routes `typeid` through AssetDocPointer.forTypeId and never
    // re-resolves the payload's `path`. So a typeid that doesn't resolve is a
    // "Missing asset" card, not a document. Addressable is not enough.
    if (payload.kind === 'entity') {
      const entity = await resolveTypeId(String(payload.typeid));
      expect(entity, `show pinned ${String(payload.typeid)} but it does not resolve`).not.toBeNull();
    }
  }, 60_000); // user-approved 60s exception 2026-07-03 (claude CLI boot alone is 15-18s;
  // the agent's flow show landed T+30-48s across runs) — do not increase further

  /**
   * Regression: a show-pinned entity target must survive the agent editing the
   * SAME document again.
   *
   * `flow show file <docs/*.md>` resolves to an `entity` target and stamps the
   * minted id into the file as an identity capsule. A full-content rewrite —
   * what an agent does on every revision — WIPES that capsule. The next index
   * walk resolves identity from the file alone
   * (index_function.py:739 `extract_id(ref) or mint_id(ref)` — no asset_ref
   * lookup, no proposed_id), so it mints a FRESH uuid4 and forks a new entity
   * for the same path; the same-path duplicate sweep then reaps the old row.
   * Everything pinned to the first id — `context_data.last_shown`,
   * `display_stack`, auto-bookmarks — is left pointing at a dead entity.
   *
   * No Claude worker here: the LLM is not part of the mechanism. This drives
   * the same real server calls the worker's CLI makes — the `show` action, a
   * real file rewrite, and a real (path-bounded) index walk.
   */
  it('a show-pinned entity target survives the agent rewriting the same doc', async (context: any) => {
    await apiTestSetup(getTestSignupInfo(), context.task.name);

    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-show-pin-'));
    const docs = path.join(workdir, 'docs');
    fs.mkdirSync(docs, { recursive: true });
    // Under a `docs/` root so `flow show file` takes the entity branch
    // (display_target.py `_is_docs_markdown_path`) rather than a raw vfs path.
    const doc = path.join(docs, 'deliverable.md');
    fs.writeFileSync(doc, '# Deliverable\n\nfirst revision.\n');

    proc = await new AgenticProcess({ workdir, pty_mode: false, load_flowpad_assistant: false }).save([]);

    // 1. The agent presents its deliverable — the real `flow show` action.
    const pinned = await showOwnerId(proc, doc);
    expect(pinned, 'flow show resolved an entity id for the doc').toBeTruthy();
    expect(await resolveTypeId(`markdown-${pinned}`), 'pinned target resolves right after show').not.toBeNull();

    // 2. The agent revises the deliverable: a full-content overwrite, which
    //    wipes the identity capsule `show` just stamped into the file.
    fs.writeFileSync(doc, '# Deliverable\n\nsecond revision — rewritten by the agent.\n');
    expect(fs.readFileSync(doc, 'utf8'), 'rewrite wiped the identity capsule').not.toContain('flowpad:capsule');

    // 3. The index walk picks the rewritten file up (path-bounded — the same
    //    endpoint the post-write "open it" flow uses).
    await apiClient.post<unknown>(
      `/graph/compute_node/@local/fs-records/index?type=markdown&path=${encodeURIComponent(docs)}`,
      {},
    );

    // 4. The pinned target must still be THIS document's entity. A fork here
    //    is what strands last_shown / display_stack / bookmarks on a dead id.
    expect(await showOwnerId(proc, doc), `the doc forked to a new entity; ${pinned} no longer owns it`).toBe(pinned);
    expect(await resolveTypeId(`markdown-${pinned}`), `pinned target ${pinned} was reaped`).not.toBeNull();
  });
});
