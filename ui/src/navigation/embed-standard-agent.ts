import type { AgenticProcess } from '@sdk';
import { systemSubagentRef } from '@src/pages/flow-page/vibe-personas';

// The standard sub-agent's asset_ref is stable for the app's lifetime — resolve
// once, reuse across chats. Raw graph route (not useEntitiesQuery) because
// system (SDK-shipped) sub-agents only surface with include_system=true. Failed
// lookups are NOT cached so a late-indexed sub-agent is picked up on the next
// chat.
//
// Resolve the SUBAGENT named `standard` (`.claude/agents/standard.md`) by
// (name, scope) — NOT by bare name, and NOT against `/graph/agent`. See the
// same comment above `resolveVibeSubagentRef` (use-start-vibe-session.ts): the old
// bare-name lookup there matched a launchable `Agent` that happened to share the
// name, so every session silently ran a generic "you are the project assistant"
// prompt with no presentation rules and no error. `scope: 'system'` pins this to
// the SDK-shipped asset so a project subagent someone names `standard` can't
// shadow it.
const resolveStandardAgentRef = () => systemSubagentRef('standard');

/**
 * Ride the SDK-shipped `standard` persona on a process so the chat-mode
 * presentation contract (build for real, then `flow show` it as a tab beside
 * the chat — there is no display pane outside vibe) is active.
 *
 * Best-effort, and deliberately never throws: an un-indexed or unreachable
 * sub-agent degrades to a plain assistant session (logged only). `openNewChat`'s
 * callers include two fire-and-forget (`void openNewChat(...)`) call sites, one
 * with no `.catch` at all, and another whose `.catch` opens the Capabilities
 * view — so a rejection here would surface as an unhandled rejection or as a
 * bogus "your harness is missing" prompt. Same contract as `embedVibeSubagent`.
 */
export async function embedStandardAgent(proc: AgenticProcess): Promise<void> {
  try {
    const ref = await resolveStandardAgentRef();
    if (ref) await proc.loadEmbeddedSubagent(ref);
    else console.warn('[Standard] standard sub-agent not indexed; continuing without persona');
  } catch (e) {
    console.warn('[Standard] failed to embed standard sub-agent; continuing without persona', e);
  }
}
