import { useLingui } from '@lingui/react/macro';
import { dataContext, editorForPath, FSRef, openTerminalFromComputeNode, type Tab } from '@sdk';
import { LOCAL_COMPUTE_NODE as LOCAL_NODE } from '@src/navigation/asset-doc-types';
import { FolderOpen, PanelTop, SquareTerminal } from 'lucide-react';
import { useEntity } from '@src/hooks/entity-hooks';
import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { useEntityLocationLabel } from '@src/components/graph-view/ui/EntityIcon';
import { TabTooltipName } from '@src/components/tabs/TabTooltipName';
import { SEGMENTED_BUTTON, SEGMENTED_GROUP, SEGMENTED_IDLE } from '@src/components/ui/segmented';
import { MODE_ICONS, MODE_LABELS, MODE_TAGS } from '@src/components/view-mode/mode-vocabulary';
import { useIsAdvanced, ViewMode } from '@src/contexts/view-mode-context';
import { contentAssetTargetForDock } from '@src/navigation/content-asset-dock';
import type { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ContentTabTooltip, WorkdirLine } from '@src/tabs/provider-meta';
import { tagAttrs } from '@src/tags/tag-attrs';
import { basename, normalizePath } from '@src/components/asset-manager/asset-row-helpers';
import React, { useMemo } from 'react';

/** The surfaces a review can start on. A function, not a module constant: this file sits in an
 *  import cycle with the view-mode context, and `ViewMode` is not there yet while it loads. */
const reviewModes = () => [ViewMode.Vibe, ViewMode.Standard, ViewMode.Advanced];

/**
 * Hover card for a document tab, in every view mode: what the document is and
 * where it lives, plus a Vibe | Chat | Terminal bar that starts a NEW session
 * reviewing it — the tab itself stays put. Advanced mode keeps the fuller
 * `ContentTabTooltip` above the bar.
 */
export const DocTabCard: React.FC<{
  tab: Tab;
  dock: DockPointer;
  typeLabel: string;
  statusReason?: string;
  location?: boolean;
  /** The document on screen, when the tab's stored name is its scope ("<project>'s Assets"). */
  name?: string;
}> = ({ tab, dock, typeLabel, statusReason, location, name }) => {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const isAdvanced = useIsAdvanced();
  const locationLabel = useEntityLocationLabel(location);
  // A path-addressed document carries its path; one addressed by id has it on its entity,
  // read when the card opens.
  const dockPath = contentAssetTargetForDock(dock)?.path;
  const targetTypeId = useMemo(() => dock.targetTypeId, [dock]);
  const entity = useEntity(targetTypeId, { enabled: !!targetTypeId && !dockPath }).data as
    | { asset_ref?: string | null }
    | null
    | undefined;
  const path = dockPath || entity?.asset_ref || undefined;
  // What it is: the entity's type, else the editor the dock opens it in (task, markdown, html…),
  // else the file's own kind, else the tab's type label.
  const kind = targetTypeId
    ? labelForType(targetTypeId.type)
    : dock.assetEditor || (path ? editorForPath(path) : typeLabel);

  return (
    <div className="min-w-[220px] max-w-[320px] space-y-2 p-2.5" data-testid="doc-tab-card">
      {isAdvanced ? (
        <ContentTabTooltip tab={tab} typeLabel={typeLabel} statusReason={statusReason} location={location} />
      ) : (
        <div className="space-y-1">
          <TabTooltipName name={name || tab.name || typeLabel} />
          {statusReason && <p className="text-[11px] text-amber-500">{statusReason}</p>}
          <p className="text-[11px] text-muted-foreground" data-testid="doc-tab-card-kind">
            {[kind, locationLabel].filter(Boolean).join(' · ')}
          </p>
          {path && <WorkdirLine workdir={path} />}
        </div>
      )}
      {path && <OpenInBar path={path} />}
      <div className="flex items-center justify-between gap-2 border-t pt-2">
          <span className="text-[11px] text-muted-foreground">{t`Review in`}</span>
          <div className={SEGMENTED_GROUP} data-testid="doc-tab-card-review">
            {reviewModes().map((mode) => {
              const Icon = MODE_ICONS[mode];
              // A Vibe session belongs to a project; a projectless tab has none to give it.
              if (mode === ViewMode.Vibe && !tab.project_id) return null;
              return (
                <button
                  key={mode}
                  type="button"
                  title={MODE_LABELS[mode]}
                  aria-label={MODE_LABELS[mode]}
                  data-testid={`doc-tab-card-review-${mode}`}
                  {...tagAttrs(MODE_TAGS[mode], 'button')}
                  onClick={(e) => {
                    e.stopPropagation();
                    void navigation.reviewDocument(dock, mode, tab.project_id, path);
                  }}
                  className={`${SEGMENTED_BUTTON} ${SEGMENTED_IDLE}`}
                >
                  <Icon className="h-3 w-3" />
                </button>
              );
            })}
        </div>
      </div>
    </div>
  );
};

/** The folder that holds `path` (the path itself when it has no file part). */
const parentDir = (path: string) => path.replace(/[\\/][^\\/]*$/, '') || path;

/** Open the document's folder in a terminal, Finder/Explorer, or Flowpad's own file browser. */
const OpenInBar: React.FC<{ path: string }> = ({ path }) => {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const computeNodeId = dataContext.computeNode?.id;
  const fsRef = new FSRef(path, LOCAL_NODE);
  const dir = parentDir(path);
  const actions = [
    computeNodeId && {
      id: 'terminal',
      label: t`Open in terminal`,
      Icon: SquareTerminal,
      run: () => void openTerminalFromComputeNode(computeNodeId, '', dir),
    },
    fsRef.localComputeNodeId && {
      id: 'finder',
      label: t`Open in Finder/Explorer`,
      Icon: FolderOpen,
      run: () => void fsRef.open({ select: true }),
    },
    {
      id: 'flowpad',
      label: t`Open in Flowpad browser`,
      Icon: PanelTop,
      run: () => navigation.openFolder(dir, basename(normalizePath(path))),
    },
  ].filter(Boolean) as { id: string; label: string; Icon: typeof FolderOpen; run: () => void }[];
  return (
    <div className="flex items-center justify-between gap-2 border-t pt-2">
      <span className="text-[11px] text-muted-foreground">{t`Open in`}</span>
      <div className={SEGMENTED_GROUP} data-testid="doc-tab-card-open">
        {actions.map(({ id, label, Icon, run }) => (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            data-testid={`doc-tab-card-open-${id}`}
            onClick={(e) => {
              e.stopPropagation();
              run();
            }}
            className={`${SEGMENTED_BUTTON} ${SEGMENTED_IDLE}`}
          >
            <Icon className="h-3 w-3" />
          </button>
        ))}
      </div>
    </div>
  );
};
