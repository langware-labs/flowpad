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
import { FlaskConical, MessageSquare, SquareTerminal, WandSparkles, type LucideIcon } from 'lucide-react';
import { useState } from 'react';

// Labelled by the SURFACE each mode shows, not by its rank — the mode selector
// is what picks vibe / chat pane / terminal, so "Standard"/"Advanced" would be
// telling the user about an internal hierarchy instead of what they get. The
// enum values stay `standard`/`advanced` (persisted preference, URL param).
const LABELS: Record<ViewMode, string> = {
  [ViewMode.Vibe]: 'Vibe',
  [ViewMode.Standard]: 'Chat',
  [ViewMode.Advanced]: 'Terminal',
  [ViewMode.Dev]: 'Dev',
};

const ICONS: Record<ViewMode, LucideIcon> = {
  [ViewMode.Vibe]: WandSparkles,
  [ViewMode.Standard]: MessageSquare,
  [ViewMode.Advanced]: SquareTerminal,
  [ViewMode.Dev]: FlaskConical,
};

/** Tag word per mode — the observable/highlightable name of each button.
 *  Spelled out rather than derived from the enum so the vocabulary is greppable
 *  (a journey authoring `ViewModeChat` should find this line). */
const TAGS: Record<ViewMode, string> = {
  [ViewMode.Vibe]: 'ViewModeVibe',
  [ViewMode.Standard]: 'ViewModeChat',
  [ViewMode.Advanced]: 'ViewModeTerminal',
  [ViewMode.Dev]: 'ViewModeDev',
};

// Visual order of the segmented control: fullest → simplest, so newly revealed
// modes grow to the LEFT. Which of these actually render is decided per render.
const DISPLAY_ORDER = [ViewMode.Dev, ViewMode.Advanced, ViewMode.Standard, ViewMode.Vibe] as const;

// Module scope so a reveal survives footer remounts across navigations;
// intentionally NOT persisted — a reload hides Advanced/Dev again.
let sessionRevealed: ReadonlySet<ViewMode> = new Set();

/** Test-only: forget double-click reveals between test cases. */
export function resetRevealedModes() {
  sessionRevealed = new Set();
}

/**
 * Footer segmented control for the global view mode — THE mode selector. Each
 * mode is a surface: Vibe (workspace), Chat (pane), Terminal (xterm), and the
 * change is a real one — a session's transport follows the mode (see
 * `useSessionSurfaceReconcile`), and new chats open in it.
 *
 * All three surfaces always render; Dev stays hidden until double-clicking the
 * selected Terminal button reveals it (revealing never selects). Every mode at
 * or below the current one always renders too, so landing in Dev (persisted pref
 * or URL override) can't hide the selected button. One icon button per mode,
 * tooltip carries the name. Lives at the far left.
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
  const [revealed, setRevealed] = useState(sessionRevealed);
  const reveal = (m: ViewMode) => {
    sessionRevealed = new Set([...sessionRevealed, m]);
    setRevealed(sessionRevealed);
  };
  // Vibe / Chat / Terminal are the three surfaces and are always offered — this
  // is the mode selector, not a power-user ladder. Only Dev is hidden, until the
  // double-click reveal on Terminal (or until it IS the mode, so landing there
  // from a stored pref or a URL can never hide the selected button).
  const modes = DISPLAY_ORDER.filter((m) => m !== ViewMode.Dev || revealed.has(ViewMode.Dev) || mode === ViewMode.Dev);

  // URL-first: the click only navigates — same pointer, requested mode. All
  // arrangements (applying + persisting the mode) happen on load, driven by the
  // URL (useDockViewModeOverrideSync). Pointerless routes (e.g. home) have no
  // dock URL to carry the mode, so they write the preference directly.
  const select = (next: ViewMode) => {
    if (next === mode) return;
    // Belt-and-braces for non-pointer callers (keyboard activation, a test
    // firing onClick directly): `disabled` already stops the pointer path.
    if (blocked(next)) return;
    if (currentDock) {
      navigation.openDock(currentDock.withViewMode(next));
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
        {modes.map((m) => {
          const Icon = ICONS[m];
          const active = m === mode;
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
                  // Reveal-only: adds the next mode's button, never selects it.
                  // No dblclick/click disambiguation needed — the two preceding
                  // clicks hit select(m) with m === mode, which early-returns.
                  onDoubleClick={() => {
                    if (m === mode && m === ViewMode.Advanced) reveal(ViewMode.Dev);
                  }}
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
