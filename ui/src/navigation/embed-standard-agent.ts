import { apiClient } from '@sdk';
import type { AgenticProcess } from '@sdk';

// The standard agent's asset_ref is stable for the app's lifetime — resolve
// once, reuse across chats. Raw graph route (not useEntitiesQuery) because
// system (SDK-shipped) agents only surface with include_system=true. Failed
// lookups are NOT cached so a late-indexed agent is picked up on the next chat.
//
// Resolve the SUBAGENT named `standard` (`.claude/agents/standard.md`) by
// (name, scope) — NOT by bare name, and NOT against `/graph/agent`. See the
// same comment above `resolveVibeAgentRef` (use-start-vibe-session.ts): the old
// bare-name lookup there matched a launchable `Agent` that happened to share the
// name, so every session silently ran a generic "you are the project assistant"
// prompt with no presentation rules and no error. `scope: 'system'` pins this to
// the SDK-shipped asset so a project subagent someone names `standard` can't
// shadow it.
let standardAgentRefCache: string | null = null;

async function resolveStandardAgentRef(): Promise<string | null> {
  if (standardAgentRefCache) return standardAgentRefCache;
  const rows = await apiClient.get<{ name?: string; scope?: string; asset_ref?: string }[]>(
    '/graph/subagent?include_system=true',
  );
  standardAgentRefCache =
    (rows ?? []).find((r) => r.name === 'standard' && r.scope === 'system')?.asset_ref ?? null;
  return standardAgentRefCache;
}

/**
 * Ride the SDK-shipped `standard` persona on a process so the chat-mode
 * presentation contract (build for real, then `flow show` it as a tab beside
 * the chat — there is no display pane outside vibe) is active.
 *
 * Best-effort, and deliberately never throws: an un-indexed or unreachable
 * agent degrades to a plain assistant session (logged only). `openNewChat`'s
 * callers include two fire-and-forget (`void openNewChat(...)`) call sites, one
 * with no `.catch` at all, and another whose `.catch` opens the Capabilities
 * view — so a rejection here would surface as an unhandled rejection or as a
 * bogus "your harness is missing" prompt. Same contract as `embedVibeAgent`.
 */
export async function embedStandardAgent(proc: AgenticProcess): Promise<void> {
  try {
    const ref = await resolveStandardAgentRef();
    if (ref) await proc.loadEmbeddedAgent(ref);
    else console.warn('[Standard] standard agent not indexed; continuing without persona');
  } catch (e) {
    console.warn('[Standard] failed to embed standard agent; continuing without persona', e);
  }
}
