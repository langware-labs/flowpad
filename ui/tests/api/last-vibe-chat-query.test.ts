/**
 * The selection behind Vibe's Chats icon
 * (`pages/flow-page/use-last-vibe-chat.ts`), run against a real backend.
 *
 * Worth an API-tier test because the filter leans on things a unit test would
 * only assume: the unary `$IS_NOT_NULL` leaf and `$EQ` against `process_type`,
 * both JSON-blob fields evaluated by the driver's partial-pushdown path. If
 * either degraded, the icon would quietly resume the wrong session — a
 * background run, or simply an arbitrary chat.
 *
 * Exercises the REAL exported query + ranking, not a restatement of them.
 *
 * NOTE on ranking: `pickLastVibeChat` sorts client-side deliberately. An
 * `order_by: { last_active_at: 'desc' }` on the query is silently a no-op —
 * `_apply_sorting` in the SQLite driver reads sort keys via
 * `getattr(record, field)`, and a DBBaseRecord carries only the COLUMN fields as
 * attributes, so every JSON-field sort key resolves to "". The query therefore
 * asks for no order at all, and the last test here pins that the ranking holds
 * whatever order the rows arrive in.
 */
import { AgenticProcess, Project, ProcessKind } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { trackForCleanup } from '../_cleanup';
import type { TestContext } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import {
  lastVibeChatQuery,
  pickLastVibeChat,
} from '@src/pages/flow-page/vibe-process-resolver';

/** Fixed and far apart, so ordering can't hinge on clock skew. */
const OLD = 1_700_000_000_000;
const MID = 1_700_000_100_000;
const NEW = 1_700_000_200_000;

describe('last-vibe-chat selection', () => {
  const signupInfo = getTestSignupInfo();
  let project: Project;

  beforeEach(async (context: TestContext) => {
    await apiTestSetup(signupInfo, context.task.name);
    project = trackForCleanup(await new Project({ name: `/tmp/flow_test_last_vibe_${Date.now()}` }).save([]));
  });

  /**
   * Saved with NO graph scope — only the `project_id` field.
   *
   * This mirrors how real processes exist, and it is the whole point: an earlier
   * version of the query passed `scope: [TypeId(project, id)]` and matched zero
   * rows in the running app, because an AgenticProcess is not a scoped
   * descendant of its project the way an asset is. Fixtures saved WITH a scope
   * hid that — they made the broken query pass. Do not add a scope here.
   */
  const makeProcess = (
    name: string,
    processType: string,
    lastActiveAt?: number,
    target?: string,
  ) =>
    new AgenticProcess({
      name,
      project_id: project.id,
      process_type: processType,
      ...(target ? { target_typeid_str: target } : {}),
      ...(lastActiveAt === undefined ? {} : { last_active_at: lastActiveAt }),
    }).save([]);

  /** Run the feature exactly as the click path does. */
  const resolve = async (projectId = project.id) =>
    pickLastVibeChat(await AgenticProcess.query<AgenticProcess>(lastVibeChatQuery(projectId), true));

  it('picks the most recently OPENED chat', async () => {
    await makeProcess('older chat', ProcessKind.Chat, OLD);
    const expected = await makeProcess('newer chat', ProcessKind.Chat, MID);

    expect((await resolve())?.id).toBe(expected.id);
  });

  it('picks the newest even when it was created first', async () => {
    // Guards against "returns whatever came back first" passing by luck: here
    // creation order and recency order disagree.
    const expected = await makeProcess('created first, opened last', ProcessKind.Chat, NEW);
    await makeProcess('created last, opened first', ProcessKind.Chat, OLD);

    expect((await resolve())?.id).toBe(expected.id);
  });

  it('never picks a background run, even when it is the most recent thing', async () => {
    const chat = await makeProcess('the real chat', ProcessKind.Chat, MID);
    // A background execution that ran later than the chat — the case that made
    // transcript-recency sources pick the wrong session.
    await makeProcess('background execution', ProcessKind.Execution, NEW);

    expect((await resolve())?.id).toBe(chat.id);
  });

  it('excludes a chat that was never opened in the UI (no last_active_at stamp)', async () => {
    await makeProcess('never opened', ProcessKind.Chat);

    expect(await resolve()).toBeNull();
  });

  it('resolves to nothing for a project with no chats at all', async () => {
    const empty = trackForCleanup(await new Project({ name: `/tmp/flow_test_last_vibe_empty_${Date.now()}` }).save([]));
    expect(await resolve(empty.id)).toBeNull();
  });

  it("does not leak another project's chat", async () => {
    const other = trackForCleanup(await new Project({ name: `/tmp/flow_test_last_vibe_other_${Date.now()}` }).save([]));
    await makeProcess('mine', ProcessKind.Chat, OLD);
    await new AgenticProcess({
      name: 'theirs',
      project_id: other.id,
      process_type: ProcessKind.Chat,
      last_active_at: NEW,
    }).save([]);

    expect((await resolve())?.name).toBe('mine');
    expect((await resolve(other.id))?.name).toBe('theirs');
  });

  it('ranks without depending on the order the server returned', async () => {
    // pickLastVibeChat must be total over the candidate set, whatever order it
    // arrives in — the query carries no `order_by` precisely because a
    // JSON-field sort is a no-op server-side (see the file header).
    const a = await makeProcess('a', ProcessKind.Chat, OLD);
    const b = await makeProcess('b', ProcessKind.Chat, NEW);
    const c = await makeProcess('c', ProcessKind.Chat, MID);

    const candidates = await AgenticProcess.query<AgenticProcess>(lastVibeChatQuery(project.id), true);
    expect(new Set(candidates.map((p) => p.id))).toEqual(new Set([a.id, b.id, c.id]));
    expect(pickLastVibeChat(candidates)?.id).toBe(b.id);
    expect(pickLastVibeChat([...candidates].reverse())?.id).toBe(b.id);
  });

});
