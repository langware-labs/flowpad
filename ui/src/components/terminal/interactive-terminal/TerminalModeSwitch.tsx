import { FlaskConical, Loader2, MessageSquare, SquareTerminal, WandSparkles, type LucideIcon } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import {
  SEGMENTED_ACTIVE,
  SEGMENTED_BUTTON,
  SEGMENTED_GROUP,
  SEGMENTED_IDLE,
} from '@src/components/ui/segmented';
import type { ProcessModeSwitch } from './use-process-mode-switch';
import { surfaceForViewMode, viewModePtyMode, ViewMode } from '@src/contexts/view-mode-context';

interface TerminalModeSwitchProps {
  /** The mode the session is CURRENTLY shown in — the selected segment. */
  current: ViewMode;
  /** Whether the vibe segment is offered (hidden in a popped-out window). */
  showVibe: boolean;
  /** The shared switch: live transport, readiness gate, in-flight flag, and the
   *  one `select`. Taken whole rather than re-spelled as four props, so adding a
   *  field to the hook doesn't ripple through both mounts. `live` is the hook's
   *  entity passthrough for other consumers — nothing here reads it. */
  modeSwitch: Omit<ProcessModeSwitch, 'live'>;
}

const ICONS: Record<ViewMode, LucideIcon> = {
  [ViewMode.Vibe]: WandSparkles,
  [ViewMode.Standard]: MessageSquare,
  [ViewMode.Advanced]: SquareTerminal,
  [ViewMode.Dev]: FlaskConical,
};

/**
 * The session's mode switch — chat | terminal | vibe — where the CURRENT mode is
 * the selected segment. Rendered leftmost in the terminal header, and in vibe's
 * display tab strip (where `vibe` is the selected one).
 *
 * Purely presentational: every pick is handed to `onSelect`, and
 * `useProcessModeSwitch` owns what it means (navigate, plus a transport switch
 * when the pick disagrees with `pty_mode`). Gating follows from that split — a
 * pick that needs no transport work is never disabled, which covers `vibe`
 * always, and covers the segment already matching the transport (in Standard
 * that is how you watch the raw terminal while the agent works).
 *
 * Visual language is the app's canonical segmented control (see the footer
 * `ViewToggle`, which shares `SEGMENTED_*`). Native `title` rather than the
 * `Tooltip` wrapper, so disabled segments still explain themselves without a
 * wrapper `<span>` swallowing clicks.
 */
export function TerminalModeSwitch({ current, showVibe, modeSwitch }: TerminalModeSwitchProps) {
  const { ptyMode, switching, awaitingUserInput: enabled, select } = modeSwitch;
  const { t } = useLingui();
  const labels: Record<ViewMode, string> = {
    [ViewMode.Vibe]: t`Vibe`,
    [ViewMode.Standard]: t`Chat`,
    [ViewMode.Advanced]: t`Terminal`,
    [ViewMode.Dev]: t`Dev`,
  };
  // The three surfaces, in the footer toggle's order. Dev renders only when it
  // IS the current mode, so the selection stays truthful without putting a
  // power-user tier in a session header.
  const modes: ViewMode[] = [
    ...(showVibe ? [ViewMode.Vibe] : []),
    ViewMode.Standard,
    ViewMode.Advanced,
    ...(current === ViewMode.Dev ? [ViewMode.Dev] : []),
  ];

  return (
    <div
      data-testid="terminal-mode-switch"
      role="radiogroup"
      aria-label={t`Session mode`}
      // State contract read by the switch stress test: the transport gate, the
      // in-flight flag, and which renderer is up.
      data-switching={switching}
      data-toggle-enabled={enabled}
      data-chat-active={surfaceForViewMode(current) === 'chat'}
      className={`${SEGMENTED_GROUP} shrink-0`}
    >
      {modes.map((mode) => {
        const active = mode === current;
        // Vibe only navigates; so does a pick whose transport already matches.
        const free = surfaceForViewMode(mode) === 'vibe' || viewModePtyMode(mode) === ptyMode;
        const disabled = !free && (switching || !enabled);
        // The spinner marks the segment whose TRANSPORT is moving. Deliberately
        // not `&& !active`: navigation lands first, so the destination is already
        // the selected segment by the time the worker starts switching — gating
        // on !active made the spinner unreachable.
        const spinning = switching && !free;
        const Icon = spinning ? Loader2 : ICONS[mode];
        const title = spinning
          ? t`Switching…`
          : disabled
            ? t`Available when the agent is waiting for your input`
            : mode === ViewMode.Vibe
              ? t`Continue in vibe mode`
              : labels[mode];
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={labels[mode]}
            data-testid={`terminal-mode-${mode}`}
            disabled={disabled}
            title={title}
            onClick={() => select(mode)}
            className={`${SEGMENTED_BUTTON} ${active ? SEGMENTED_ACTIVE : SEGMENTED_IDLE} ${
              disabled ? 'cursor-not-allowed opacity-50' : ''
            }`}
          >
            <Icon className={`h-3 w-3 ${spinning ? 'animate-spin' : ''}`} />
          </button>
        );
      })}
    </div>
  );
}
