import { Loader2, MessageSquare, SquareTerminal, WandSparkles, type LucideIcon } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import {
  SEGMENTED_ACTIVE,
  SEGMENTED_BUTTON,
  SEGMENTED_GROUP,
  SEGMENTED_IDLE,
} from '@src/components/ui/segmented';
import type { SessionMode, TransportMode } from './use-process-mode-switch';

interface TerminalModeSwitchProps {
  /** The mode the session is CURRENTLY shown in — the selected segment. */
  current: SessionMode;
  /** The mode the session's TRANSPORT is on (`pty_mode`). Usually equals
   *  `current`, but Standard paints the chat pane over a live PTY, and in vibe
   *  `current` is 'vibe' while the transport is still one of the two — so
   *  picking the segment that already matches the transport does no work. */
  transport: TransportMode;
  /** A transport switch is in flight (spinner on the target segment). */
  switching: boolean;
  /** `isReadyForInput` — the backend 409s a mid-turn transport switch. */
  enabled: boolean;
  /** Whether the vibe segment is offered (hidden in a popped-out window). */
  showVibe: boolean;
  onSelect: (mode: SessionMode) => void;
}

const ICONS: Record<SessionMode, LucideIcon> = {
  chat: MessageSquare,
  terminal: SquareTerminal,
  vibe: WandSparkles,
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
export function TerminalModeSwitch({
  current,
  transport,
  switching,
  enabled,
  showVibe,
  onSelect,
}: TerminalModeSwitchProps) {
  const { t } = useLingui();
  const labels: Record<SessionMode, string> = { chat: t`Chat`, terminal: t`Terminal`, vibe: t`Vibe` };
  const modes: SessionMode[] = showVibe ? ['chat', 'terminal', 'vibe'] : ['chat', 'terminal'];

  return (
    <div
      data-testid="terminal-mode-switch"
      role="radiogroup"
      aria-label={t`Session mode`}
      // State contract read by the switch stress test: the transport gate, the
      // in-flight flag, and which renderer is up.
      data-switching={switching}
      data-toggle-enabled={enabled}
      data-chat-active={current === 'chat'}
      className={`${SEGMENTED_GROUP} shrink-0`}
    >
      {modes.map((mode) => {
        const active = mode === current;
        // Vibe only navigates; so does a pick already matching the transport.
        const free = mode === 'vibe' || mode === transport;
        const disabled = !free && (switching || !enabled);
        // The spinner marks the DESTINATION — the segment being switched to.
        const Icon = switching && !active && !free ? Loader2 : ICONS[mode];
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={labels[mode]}
            data-testid={`terminal-mode-${mode}`}
            disabled={disabled}
            title={
              switching && !free
                ? t`Switching…`
                : disabled
                  ? t`Available when the agent is waiting for your input`
                  : mode === 'vibe'
                    ? t`Continue in vibe mode`
                    : labels[mode]
            }
            onClick={() => onSelect(mode)}
            className={`${SEGMENTED_BUTTON} ${active ? SEGMENTED_ACTIVE : SEGMENTED_IDLE} ${
              disabled ? 'cursor-not-allowed opacity-50' : ''
            }`}
          >
            <Icon className={`h-3 w-3 ${switching && !active && !free ? 'animate-spin' : ''}`} />
          </button>
        );
      })}
    </div>
  );
}
