import { useLingui } from '@lingui/react/macro';
import { Agent, type AgenticProcess, Project, VFSPath } from '@sdk';
import { basename } from '@src/components/asset-manager/asset-row-helpers';
import type { DockPointer } from '@src/navigation/DockPointer';
import { dockForTarget } from '@src/navigation/navigation-decision';
import { FileText } from 'lucide-react';
import { useMemo } from 'react';
import { contentAssetTargetForDock } from '@src/navigation/content-asset-dock';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/** The doc a chat is ABOUT (`target_typeid_str`), when it is one — not a project or agent chat. */
export function docTargetOf(process: AgenticProcess | null | undefined): string | null {
  const target = process?.target_typeid_str;
  if (!target) return null;
  if (target.startsWith(`${Project.type}-`) || target.startsWith(`${Agent.type}-`)) return null;
  return target;
}

/** The doc's own dock from a chat target: a VFS path opens as a file, an entity
 *  TypeId in its editor. Null when there is no viewer for it. */
export function docDockForTarget(target: string): DockPointer | null {
  try {
    return dockForTarget({ kind: VFSPath.parse(target).isAbsolute ? 'file' : 'entity', value: target });
  } catch {
    return null;
  }
}

/**
 * The chat's side of the doc ↔ chat link: a chip naming the doc this chat is
 * about. Click → the doc opens beside this chat (`openDocInChat`). Hidden while
 * that doc is already the one beside it. The doc's side is the viewer's Chat toggle.
 */
export function VibeDocChip({ process }: { process: AgenticProcess | null | undefined }) {
  const { t } = useLingui();
  const { currentDock, navigation } = useDockNavigation();
  const target = docTargetOf(process);
  const doc = useMemo(() => (target ? docDockForTarget(target) : null), [target]);
  if (!process || !target || !doc) return null;
  const beside =
    currentDock?.hostProcessId === process.typeId.toString() &&
    contentAssetTargetForDock(currentDock)?.targetVfsPath === target;
  if (beside) return null;
  const name = basename(target) || target;
  return (
    <button
      type="button"
      title={t`Open ${name} beside this chat`}
      onClick={() => void navigation.openDocInChat(doc, process.id, process.project_id ?? null)}
      data-testid="vibe-doc-chip"
      className="flex max-w-[160px] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <FileText className="h-3 w-3 shrink-0" />
      <span className="truncate">{name}</span>
    </button>
  );
}
