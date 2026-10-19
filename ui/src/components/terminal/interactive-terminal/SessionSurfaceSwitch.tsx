import type { AgenticProcess } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { MODE_ICONS, MODE_LABELS, MODE_TAGS } from '@src/components/view-mode/mode-vocabulary';
import { tagAttrs } from '@src/tags/tag-attrs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import {
  SEGMENTED_ACTIVE,
  SEGMENTED_BUTTON,
  SEGMENTED_DISABLED,
  SEGMENTED_GROUP,
  SEGMENTED_IDLE,
} from '@src/components/ui/segmented';
import { surfaceForViewMode, useViewMode, ViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { surfaceTransportGate } from './use-process-surface';

/**
 * The session's SURFACE selector — Terminal | Chat | Vibe, the current one lit,
 * styled as the footer's mode selector (`SEGMENTED_*`). Picking one is the footer
 * switch scoped to this session (`switchSessionSurface`). A segment whose
 * transport cannot change now (mid-turn) is greyed and inert with the reason in
 * its tooltip, like the footer's (`surfaceTransportGate`).
 */
export function SessionSurfaceSwitch({ process }: { process: AgenticProcess }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const current = surfaceForViewMode(useViewMode());
  // The footer's vocabulary (labels, icons, tags), one per surface.
  const segments = [ViewMode.Advanced, ViewMode.Standard, ViewMode.Vibe].map((mode) => ({
    mode,
    surface: surfaceForViewMode(mode),
    Icon: MODE_ICONS[mode],
    label: MODE_LABELS[mode],
  }));
  return (
    <TooltipProvider delayDuration={300}>
      <div
        role="radiogroup"
        aria-label={t`Show this session as`}
        className={SEGMENTED_GROUP}
        data-testid="session-surface-switch"
      >
        {segments.map(({ mode, surface, Icon, label }) => {
          const active = surface === current;
          const gated = !active && surfaceTransportGate(process, mode).blocked;
          return (
            <Tooltip key={surface}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-disabled={gated || undefined}
                  aria-label={label}
                  data-testid={`session-surface-${surface}`}
                  {...tagAttrs(MODE_TAGS[mode], 'button')}
                  onClick={() => {
                    if (!active && !gated) navigation.switchSessionSurface(process.id, mode);
                  }}
                  className={`${SEGMENTED_BUTTON} ${gated ? SEGMENTED_DISABLED : active ? SEGMENTED_ACTIVE : SEGMENTED_IDLE}`}
                >
                  <Icon className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{gated ? t`${label} — not while the agent is working` : label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
