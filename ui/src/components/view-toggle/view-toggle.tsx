import { t } from '@lingui/core/macro';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import {
  SEGMENTED_ACTIVE,
  SEGMENTED_BUTTON,
  SEGMENTED_DISABLED,
  SEGMENTED_GROUP,
  SEGMENTED_IDLE,
} from '@src/components/ui/segmented';
import { ViewMode, setViewMode, useViewMode } from '@src/contexts/view-mode-context';
import { tagAttrs } from '@src/tags/tag-attrs';
import { useDockNavigation } from '@src/navigation';
import { useViewToggleGate } from './use-view-toggle-gate';
import { MODE_ICONS, MODE_LABELS, MODE_TAGS } from '@src/components/view-mode/mode-vocabulary';

const LABELS = MODE_LABELS;
const ICONS = MODE_ICONS;
const TAGS = MODE_TAGS;

// Visual order of the segmented control: fullest → simplest. Dev is not here:
// it is a switch (double-click your avatar in the profile menu), not a surface.
const DISPLAY_ORDER = [ViewMode.Advanced, ViewMode.Standard, ViewMode.Vibe] as const;

/**
 * Footer segmented control for the global view mode — THE mode selector. Each
 * mode is a surface: Vibe (workspace), Chat (pane), Terminal (xterm), and the
 * change is a real one — a session's transport follows the mode (see
 * `useSessionSurfaceReconcile`), and new chats open in it.
 *
 * The three surfaces always render, one icon button per mode; the tooltip
 * carries the name. Lives at the far left.
 *
 * A segment whose transport change the session cannot make right now is GREYED
 * AND INERT, with the tooltip saying why (`useViewToggleGate`). Because mode
 * selection is URL-first, a click that is going to be declined downstream still
 * succeeds at everything visible — it moves the URL, lights the segment, adopts
 * the preference — so without this the control reports a mode the session is
 * not on and nothing explains the gap. Only the segments that would actually
 * move a worker are ever gated; chat⇄vibe and re-picking the current transport
 * stay live however busy the turn is, because reading is not a lifecycle action.
 */
export function ViewToggle() {
  const persistedMode = useViewMode();
  const { currentDock, navigation } = useDockNavigation();
  const blocked = useViewToggleGate();
  // URL-first: on a dock route the URL is already authoritative in the render
  // that commits it; preference adoption follows in an effect. Reading the
  // persisted mode here can therefore show/dedupe against the previous mode
  // for one frame and drop a valid click. Pointerless routes have no URL mode,
  // so they retain the preference as their source of truth.
  const mode = currentDock?.viewMode ?? persistedMode;
  // A stored or URL mode of `dev` (from when Dev was a mode) lights Terminal —
  // the surface Dev showed — instead of a button that no longer exists.
  const lit = mode === ViewMode.Dev ? ViewMode.Advanced : mode;

  // URL-first: the click only navigates — same pointer, requested mode. All
  // arrangements (applying + persisting the mode) happen on load, driven by the
  // URL (useDockViewModeOverrideSync). Pointerless routes (e.g. home) have no
  // dock URL to carry the mode, so they write the preference directly.
  const select = (next: ViewMode) => {
    if (next === lit) return;
    // Belt-and-braces for non-pointer callers (keyboard activation, a test
    // firing onClick directly): `disabled` already stops the pointer path.
    if (blocked(next)) return;
    if (currentDock) {
      // Marked as a switch, so the sync hook saves it even from a bare URL.
      navigation.openDock(currentDock.withViewMode(next), undefined, { viewModeSwitch: true });
    } else {
      setViewMode(next);
    }
  };

  return (
    <TooltipProvider>
      <div
        data-testid="view-toggle"
        {...tagAttrs('ViewToggle', 'label')}
        role="radiogroup"
        aria-label={t`View mode`}
        className={SEGMENTED_GROUP}
      >
        {DISPLAY_ORDER.map((m) => {
          const Icon = ICONS[m];
          const active = m === lit;
          const gated = blocked(m);
          return (
            <Tooltip key={m} delayDuration={0}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  // `aria-disabled`, NOT `disabled`: a natively disabled button
                  // receives no pointer events at all in most browsers, so it
                  // cannot trigger the tooltip that explains itself. Radix's
                  // TooltipTrigger needs the hover. The click is refused in
                  // `select` instead, which also covers keyboard activation.
                  aria-disabled={gated || undefined}
                  // Keyed on the enum value, not the label: the testid is a stable
                  // contract (and matches the persisted pref / `?viewMode` value),
                  // while the label is user-facing wording that may change.
                  data-testid={`view-toggle-${m}`}
                  // The tag is what makes each mode button observable and
                  // highlightable: a click on it becomes `app.ui.button.clicked`
                  // with this word as the target. The GROUP carries `ViewToggle`
                  // for highlighting the control as a whole; clicks resolve to
                  // the nearest tagged ancestor, which is always the button.
                  {...tagAttrs(TAGS[m], 'button')}
                  onClick={() => select(m)}
                  className={`${SEGMENTED_BUTTON} ${
                    gated ? SEGMENTED_DISABLED : active ? SEGMENTED_ACTIVE : SEGMENTED_IDLE
                  }`}
                  aria-label={LABELS[m]}
                >
                  <Icon className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {gated ? t`${LABELS[m]} — not while the agent is working` : LABELS[m]}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
