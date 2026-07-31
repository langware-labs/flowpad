import {
  MarkdownEditor,
  type WikiLinkTarget,
} from '@src/components/assets/editor/markdown/MarkdownEditor';
import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { SubAgent, AgentKind, FSRef } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { useCallback, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { Loader2, Play } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { createVibeProcessForProject } from '@src/pages/flow-page/use-start-vibe-session';
import { notify } from '@src/notifications';
import { tagAttrs } from '@src/tags/tag-attrs';

interface AgentAssetEditorProps {
  /** FSRef to the agent .md file. */
  fsRef: FSRef;
  /**
   * Pre-resolved agent entity. Passed by `<EntityResolutionGate>` from
   * `AssetEditorRouter`. When omitted, the editor falls back to
   * `useEntityByPath` for backwards compatibility with direct-mount callers.
   */
  agent?: SubAgent;
  /** Wiki page/namespace to retain for links when this asset is Wiki-rendered. */
  wikiLinkTarget?: WikiLinkTarget;
}

/**
 * SubAgent files render the standard markdown editor plus a "Use agent" action.
 * The side-drawer editor process is generic (no agent embed), keyed on
 * `fsRef.vpath` (the file's compute-node-rooted VFS path) — the same surface
 * every other doc gets.
 */
export function AgentAssetEditor({
  fsRef,
  agent: providedAgent,
  wikiLinkTarget,
}: AgentAssetEditorProps) {
  const { entity: discoveredAgent } = useEntityByPath<SubAgent>(
    providedAgent ? null : SubAgent.type,
    providedAgent ? null : fsRef,
  );
  const agent = providedAgent ?? discoveredAgent;
  // Prefer the entity-derived doc (built from agent.asset_ref) once the entity
  // resolves. Falls back to the URL-derived fsRef while loading. Both resolve
  // to the same file post mount-path fix, but the entity-derived ref is the
  // explicit source of truth.
  const editorRef = agent?.doc ?? fsRef;
  // chatTarget MUST be the entity's TypeId — MarkdownEditor builds `new TypeId(chatTarget)`
  // and uses it as docTypeId. Passing a path here is what caused the "Invalid typeId" crash.
  const chatTarget = agent ? agent.typeId.toString() : null;
  const { navigation } = useDockNavigation();
  const { project } = useProject();
  const onDelete = useCallback(async () => {
    if (!agent) return;
    await agent.delete();
    navigation.openDock(DockPointer.forAssetList(SubAgent.type));
  }, [agent, navigation]);

  // "Use agent": mark it a vibe agent (the vibe layer embeds every kind==vibe
  // agent on process start) and open the vibe workspace — the agent is live in
  // a process, ready to be asked. Tag-tagged, so journeys can highlight it
  // and observe the click through the standard bus wiring.
  const [launching, setLaunching] = useState(false);
  const startUsingAgent = useCallback(async () => {
    if (!agent || !project?.id || launching) return;
    setLaunching(true);
    try {
      await agent.setKind(AgentKind.Vibe);
      await createVibeProcessForProject({ projectId: project.id, navigation });
    } catch (e) {
      notify.error({ title: e instanceof Error ? e.message : 'Failed to start the agent' });
    } finally {
      setLaunching(false);
    }
  }, [agent, project?.id, navigation, launching]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {agent && (
        <div className="flex items-center justify-end border-b border-border px-3 py-1.5">
          <Button
            type="button"
            size="sm"
            disabled={launching || !project?.id}
            onClick={() => void startUsingAgent()}
            className="h-7 gap-1.5 px-3 text-xs"
            data-testid="agent-use"
            {...tagAttrs('UseAgent', 'button')}
          >
            {launching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            <Trans>Use agent</Trans>
          </Button>
        </div>
      )}
      {/* Tagged so a journey can aim at the instructions body — highlight it, or
          fill it via `act:{kind:'fill', target:'AgentInstructions'}`. The tag
          goes on the CONTAINER; the act resolves the editable inside it, which
          the rich editor owns and may re-create. */}
      <div className="min-h-0 flex-1" {...tagAttrs('AgentInstructions', 'input')}>
        <MarkdownEditor
          fsRef={editorRef}
          chatTarget={chatTarget}
          onDelete={agent ? onDelete : undefined}
          deleteLabel={agent?.name ?? undefined}
          wikiLinkTarget={wikiLinkTarget}
        />
      </div>
    </div>
  );
}
