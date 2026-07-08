/**
 * Lens dock loader for /dock/lens/<category>/<type>/<ref>.
 *
 * Lenses are read-only viewers over worker artifacts, not entity docks. The
 * URL-first context they still owe — the active project — comes from the
 * underlying session: a `claude/transcript/<id>` lens maps to a ClaudeSession
 * (id = session id) whose indexer-resolved `project_id` (cwd as fallback) is the
 * owning project. This is the same project phase the shell/process loaders run,
 * and it reads the SAME source the tab mint uses (`target.project_id`), so the
 * active project and the minted tab never diverge.
 *
 * The session entity is already fetched + cached by the tab mint
 * (`getFromDockPointer` via `dock.targetTypeId`), so `getById` here is a cache
 * hit. Unindexed sessions / abs-path & legacy ref forms / non-claude lenses
 * degrade gracefully — the loader never parses the transcript JSONL itself, so
 * it stays fast.
 */
import { ClaudeSession, Project, systemTools, TypeId } from '@sdk';
import { DockPointer } from '@src/navigation';
import { loadProject } from './load-project';

export async function loadLensRoute(pointer: string | undefined): Promise<void> {
  if (!pointer) return;
  const lens = DockPointer.parseLensPointer(pointer);
  // Only claude transcripts map to a first-class entity (ClaudeSession). Other
  // lens kinds (codex/copilot transcripts, heartbeat, cli/log, fs-records, …)
  // have no owning project to resolve.
  if (lens?.category !== 'claude' || lens.type !== 'transcript') return;
  const sessionId = lens.ref;
  // Canonical form only — the ref is a bare session id. Abs-path / legacy
  // multi-segment forms carry no entity (the view reads them straight off disk).
  if (!sessionId || sessionId.includes('/')) return;

  const session = await ClaudeSession.getById<ClaudeSession>(sessionId).catch(() => null);
  if (!session) return;
  // Project phase — identical to the shell/process loaders: prefer the stored
  // project_id, fall back to a workdir match on cwd.
  if (session.project_id) {
    await loadProject(new TypeId(Project.type, session.project_id)).catch(() =>
      systemTools.resolveProjectContext(session.cwd ?? undefined),
    );
  } else {
    // No project_id: a cwd inside a project mount adopts the session; otherwise
    // (no cwd, or cwd outside every project) this is a global transcript and
    // resolveProjectContext clears the active project to null (the Global scope).
    await systemTools.resolveProjectContext(session.cwd ?? undefined);
  }
}
