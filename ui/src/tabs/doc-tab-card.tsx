import { useLingui } from '@lingui/react/macro';
import { editorForPath, type Tab } from '@sdk';
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
import React from 'react';

/** The surfaces a review can start on. */
const REVIEW_MODES = [ViewMode.Vibe, ViewMode.Standard, ViewMode.Advanced];

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
}> = ({ tab, dock, typeLabel, statusReason, location }) => {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const isAdvanced = useIsAdvanced();
  const locationLabel = useEntityLocationLabel(location);
  const path = contentAssetTargetForDock(dock)?.path;
  // The file's own kind when it has a path (html, markdown, …), else the tab's type label.
  const kind = path ? editorForPath(path) : typeLabel;

  return (
    <div className="min-w-[220px] max-w-[320px] space-y-2 p-2.5" data-testid="doc-tab-card">
      {isAdvanced ? (
        <ContentTabTooltip tab={tab} typeLabel={typeLabel} statusReason={statusReason} location={location} />
      ) : (
        <div className="space-y-1">
          <TabTooltipName name={tab.name || typeLabel} />
          {statusReason && <p className="text-[11px] text-amber-500">{statusReason}</p>}
          <p className="text-[11px] text-muted-foreground" data-testid="doc-tab-card-kind">
            {[kind, locationLabel].filter(Boolean).join(' · ')}
          </p>
          {path && <WorkdirLine workdir={path} />}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 border-t pt-2">
          <span className="text-[11px] text-muted-foreground">{t`Review in`}</span>
          <div className={SEGMENTED_GROUP} data-testid="doc-tab-card-review">
            {REVIEW_MODES.map((mode) => {
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
                    void navigation.reviewDocument(dock, mode, tab.project_id);
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
