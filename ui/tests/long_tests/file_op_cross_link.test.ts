/**
 * C6c — file-op cross-link end-to-end via real Claude session.
 *
 * Drives a real Claude session, prompts it to write `hello.md` containing
 * "hello world", and validates the full backend chain:
 *   - FSOp watcher detects the JSONL change
 *   - TranscriptStreamer parses delta → AgenticProcess subscriber receives
 *     a FileWriteEntry
 *   - AgenticProcess._flush_transcript_change emits a `file.write` entity_event
 *   - cross_link_file_to_process links Docs ↔ AP via private_context_entities_
 *
 * The Markdown (Docs) entity for `hello.md` is pre-created so the cross-link
 * can resolve immediately (locked decision 3 — no on-demand reindex).
 *
 * Requires: backend at LOCAL_SERVER_PORT + Claude Code installed.
 * Timeout: 240s — real Claude subprocess.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AgenticProcess, Markdown } from '@sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

function isClaudeUnavailable(content: string): boolean {
  return /(hit your limit|weekly limit|usage limit|rate limit|quota|too many requests|overloaded)/i.test(
    content,
  );
}

describe('file-op cross-link — end-to-end via real Claude Write tool', () => {
  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
  });

  let proc: AgenticProcess | null = null;
  afterEach(async () => {
    if (proc) {
      await proc.exit().catch(() => {});
      proc = null;
    }
  });

  it(
    'prompt → Claude writes hello.md → file.write event + Docs ↔ AP cross-link',
    async (context: any) => {
      // realpath: on macOS `os.tmpdir()` is `/var/...`, a symlink to
      // `/private/var/...`. The Write tool reports the CANONICAL path, so an
      // un-resolved expectation compares two spellings of the same file and
      // fails on the spelling, not on the behaviour.
      const workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-op-e2e-')));
      const targetPath = path.join(workdir, 'hello.md');

      // Pre-create the Markdown (Docs) entity so cross_link_file_to_process
      // resolves to a real record. Without this the chain still emits the
      // file.write event but returns (None, None) and skips the bidirectional
      // link (locked decision 3 — no on-demand reindex).
      const docs = await new Markdown({
        name: 'hello.md',
        asset_ref: targetPath,
      }).save([]);

      proc = await new AgenticProcess({ workdir }).save([]);
      await proc.watch();

      // Capture entity events. ``emit_entity_event`` arrives over WS as an
      // ``element-type=entity_event`` envelope which the SDK routes straight to
      // the entity's ``onEntityEvent`` hook (NOT the flow-data stream) and
      // re-emits as the ``'entity_event'`` event — see APIEntity.onEntityEvent /
      // FlowSync store.onFlowData. Subscribe on that channel, not 'flow_data'.
      const entityEvents: Array<{ event: string; payload: any }> = [];
      const unsub = proc.on('entity_event', (event: string, payload: any) => {
        entityEvents.push({ event: String(event ?? ''), payload: payload ?? {} });
      });

      const chatChunks: string[] = [];
      const unsubLine = proc.onLine((line) => {
        if (line.trim()) chatChunks.push(line);
      });

      try {
        await proc.executeInstruction(
          `Write the text "hello world" to ${targetPath}. ` +
            `Use the Write tool. Do not navigate, do not call any flowpad-assistance skill.`,
          { sync: false },
        );

        // Drain output() so the worker completes the turn, then keep polling
        // briefly in case the debounced flush arrives after the final chunk.
        const deadline = Date.now() + 200_000;
        const findWrite = () => entityEvents.find((e) => e.event === 'file.write');
        let writeEvent = findWrite();
        for await (const _ of proc.output()) {
          if (Date.now() > deadline) break;
          writeEvent = findWrite();
          if (writeEvent) break;
        }
        while (!writeEvent && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250));
          writeEvent = findWrite();
        }

        if (!writeEvent) {
          const allText = chatChunks.join('\n');
          if (isClaudeUnavailable(allText)) {
            context.skip(`Claude unavailable: ${allText.slice(0, 240)}`);
          }
          throw new Error(
            `No file.write event received within budget. ` +
              `entityEvents=${JSON.stringify(entityEvents)}; ` +
              `chat tail=${allText.slice(-400)}`,
          );
        }

        expect(writeEvent.payload?.path, 'file.write payload should carry target path').toBe(
          targetPath,
        );

        // Reload the AP and confirm the bidirectional cross-link landed.
        await proc.reload();
        const linkedToDocs = proc.privateContextEntities.find(
          (t: any) => t.id === docs.id && t.type === Markdown.type,
        );
        expect(linkedToDocs, 'AP.private_context_entities_ should contain the Docs link').toBeTruthy();

        // And the reverse — the Docs entity should reference the AP.
        await docs.reload();
        const linkedFromDocs = docs.privateContextEntities.find(
          (t: any) => t.id === proc!.id,
        );
        expect(linkedFromDocs, 'Docs.private_context_entities_ should contain the AP link').toBeTruthy();
      } finally {
        unsub();
        unsubLine();
      }
    },
    240_000,
  );
});
