import { AgenticProcess } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { describe, expect, it } from 'vitest';

/**
 * Opening a freshly forked Claude session by id lands on a dead transcript
 * lens instead of the fork's live terminal.
 *
 * `AgenticProcess.fork` pre-allocates the fork's `session_id` before the CLI
 * has written anything, but Claude Code only creates
 * `~/.claude/projects/<slug>/<session_id>.jsonl` on the fork's FIRST turn.
 * `transcriptDockPointer` guards only on `!session_id`, so a running fork —
 * which always has one — resolves to `claude/transcript/<session_id>`, and the
 * lens 404s ("No claude transcript JSONL found for session_id=…") until a
 * message is sent.
 *
 * The wire body below is the real backend payload for such a fork
 * (`GET /api/v1/graph/agentic_process/e5d3288c-…`): status running, a
 * session_id, `cli_config.fork_session_id` pointing at the parent, and no
 * transcript on disk. Note `worker_type` is null at the top level — the
 * 'claude' in the lens pointer comes from the getter's own default.
 */
const RUNNING_FORK_WIRE_ENTITY = {
  id: 'e5d3288c-bf26-4940-97e9-a12a00607bfa',
  type: 'agentic_process',
  status: 'running',
  worker_status: null,
  session_id: 'dc027eff-e0e0-4eeb-92a6-42b28bb5186e',
  worker_type: null,
  cli_config: {
    worker_type: 'claude',
    session_id: 'dc027eff-e0e0-4eeb-92a6-42b28bb5186e',
    resume: true,
    fork_session_id: '5f2a19c4-90bb-4a6d-a924-b4b70cf299b5',
    permission_mode: 'bypassPermissions',
  },
  workdir: '/Users/Gadi/Flowpad workspace/my_first_project',
  name: 'Say hi in one word (fork)',
} as const;

/** The page the user is on when the fork is opened — the parent's shell tab. */
const PARENT_SHELL_PATH = '/dock/shell/agentic_process-6c01fc44-bd62-4fd5-8269-d25c7e24fe4b';

describe('opening a running fork by id', () => {
  // One instance for both assertions — the entity registry is keyed by id, so
  // re-constructing the same fork warns about a duplicate registration.
  const fork = new AgenticProcess(RUNNING_FORK_WIRE_ENTITY);

  it('routes to the fork live terminal, not a transcript that does not exist yet', () => {
    // The same two steps `handleNavigateEntity` performs on a `navigate_entity`
    // ui_command: read the entity's dockPointer, then turn it into the URL it
    // pushes onto history.
    const url = new DockPointer(fork.dockPointer).toUrl(PARENT_SHELL_PATH);

    expect(url).toBe(`/dock/shell/agentic_process-${RUNNING_FORK_WIRE_ENTITY.id}`);
  });

  it('does not point at a session_id whose transcript has never been written', () => {
    expect(fork.dockPointer.pointer).not.toContain(RUNNING_FORK_WIRE_ENTITY.session_id);
  });
});
