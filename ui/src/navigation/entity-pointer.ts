/** Where an entity opens: the dock pointer for a `{type, id}` (plus what a few types need from the
 *  row). Navigation owns this mapping; chips, breadcrumbs, viewers and dialogs all ask it. */
import { AgenticProcess, DataSource, TypeId, workerFromSessionType } from '@sdk';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { editorForType } from '@src/navigation/asset-doc-types';
import { DockPointer } from '@src/navigation/DockPointer';
import type { SessionWorker } from '@src/hooks/use-transcript';
import { withHomePage } from '@src/project-home-page/home-page-state';

/**
 * Map an entity-type pair to the right DockPointer factory.
 * Centralised here so `EntityChip` itself stays declarative.
 *
 * For unknown entity types, falls back to a generic
 * ``/dock/<type>/<id>`` pointer via ``DockPointer.fromUrl``. The dock
 * router validates and 404s gracefully if there is no matching view —
 * silent no-ops on click are worse than a visible "unknown view" page.
 */
export function buildDockPointer(
  resolved: { type: string; id: string },
  inside: { type: string; id: string } | undefined,
): DockPointer | null {
  switch (resolved.type) {
    case 'project':
      // From a conversation, a project chip lands like the asset review popup's
      // Open (ProjectInstallAction): the bare project asking for its home page.
      // A `/conversation/<cid>` sub-path would stop the home-page redirect.
      return inside?.type === 'conversation'
        ? withHomePage(DockPointer.forProject(resolved.id))
        : DockPointer.forProject(resolved.id);
    case 'task':
      return DockPointer.forTasks(
        resolved.id,
        inside?.type === 'conversation' ? { conversationId: inside.id } : undefined,
      );
    case 'spec':
      return DockPointer.forSpec(resolved.id);
    case 'flowpad_diagnosis':
      // Entity type is `flowpad_diagnosis` but the view type is `diagnosis`, so the
      // generic fallback can't resolve it — map explicitly to the diagnosis viewer.
      return DockPointer.forDiagnosis(resolved.id);
    case DataSource.type:
      return DockPointer.forDataSources({ section: 'source', id: resolved.id, tab: null });
    case 'conversation':
      return DockPointer.forConversation(resolved.id);
    case AgenticProcess.type:
      // A session opens in its own tab (the shell dock). `/dock/agentic_process/<id>` has no view.
      return DockPointer.forSession(resolved.id);
    case 'flow_message': {
      // A message opens in its conversation, scrolled to it.
      const conversationId = (resolved as { conversation_id?: string | null }).conversation_id;
      return conversationId ? DockPointer.forConversation(conversationId, { messageId: resolved.id }) : null;
    }
    case 'claude_session':
    case 'codex_session':
    case 'copilot_session':
    case 'opencode_session':
    case 'deepagents_session': {
      const worker = workerFromSessionType(resolved.type) as SessionWorker;
      // Transcripts are the ONLY type addressed by location rather than by
      // TypeId (they have no asset-editor entry — they open through the lens,
      // which takes a worker + a file). So unlike every other case here, a bare
      // {type, id} is NOT enough to build a working pointer, and the caller must
      // pass the resolved entity.
      const session = resolved as { asset_ref?: string | null; received?: boolean };
      const ref = session.asset_ref?.trim();
      if (ref) return DockPointer.forLensTranscript(worker, ref);
      // No path in hand. The session-id form is answered by
      // ``resolve_session_jsonl``, which searches THIS machine's CLI dir — right
      // for a locally-run session, and guaranteed to 404 for a received one
      // ("NOT_FOUND: ~/.claude/projects/ ... cannot resolve session <id>"). So
      // only take it on an entity that explicitly says it ran here. `undefined`
      // means the caller handed us a stub and we simply don't know — returning
      // null lets them fall back instead of opening a broken tab.
      if (session.received === false) return DockPointer.forLensTranscript(worker, resolved.id);
      return null;
    }
    default: {
      // Asset-editor types (markdown family, agent, skill, workflow, chart)
      // open by their TypeId — no asset_ref needed; the loader resolves the
      // entity. This is why the chip never has to defer on an unresolved path.
      const editor = editorForType(resolved.type);
      if (editor) {
        return AssetDocPointer.forTypeId(editor, new TypeId(resolved.type, resolved.id)).toDockPointer();
      }
      try {
        return DockPointer.fromUrl(resolved.type, resolved.id);
      } catch {
        // The view-type registry rejected this type. Log so the
        // misconfiguration is visible during development; return null so
        // the click is a no-op rather than throwing into the React tree.
        console.warn(`[entity-pointer] no dock target for type=${resolved.type}`);
        return null;
      }
    }
  }
}
