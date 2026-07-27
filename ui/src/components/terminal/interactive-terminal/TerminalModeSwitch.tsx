import { Loader2, MessageSquare, SquareTerminal, WandSparkles, type LucideIcon } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import {
  SEGMENTED_ACTIVE,
  SEGMENTED_BUTTON,
  SEGMENTED_GROUP,
  SEGMENTED_IDLE,
} from '@src/components/ui/segmented';
import type { TransportMode } from './use-process-mode-switch';

interface TerminalModeSwitchProps {
  /** The mode the session is CURRENTLY showing — the selected segment (the SKIN). */
  current: TransportMode;
  /** The mode the session's TRANSPORT is on (`pty_mode`). Usually equal to
   *  `current`, but Standard view paints the chat pane over a live PTY — so
   *  picking the segment that already matches the transport is a free skin flip. */
  transport: TransportMode;
  /** A transport switch is in flight (spinner on the target segment). */
  switching: boolean;
  /** `isReadyForInput` — the backend 409s a mid-turn transport switch. */
  enabled: boolean;
  /** Whether the vibe segment is offered (see ProcessToolbar's dock gate). */
  showVibe: boolean;
  onSelect: (mode: TransportMode) => void;
  onVibe: () => void;
}

const ICONS: Record<TransportMode, LucideIcon> = {
  chat: MessageSquare,
  terminal: SquareTerminal,
};

/**
 * The session's mode switch — chat | terminal | vibe — rendered leftmost in the
 * terminal header. The CURRENT mode is the selected segment.
 *
 * Two segments, two very different kinds of action:
 *
 * - `chat` / `terminal` are the two TRANSPORTS of this one session. Selecting
 *   one is a real lifecycle action (`switchMode`, see `useProcessModeSwitch`),
 *   so they carry the mid-turn gate and the in-flight spinner.
 * - `vibe` is a SKIN, not a transport: it reuses the Discuss affordance
 *   ("continue this conversation in vibe mode") — pure `?viewMode=vibe`
 *   navigation onto the very same process dock, no transport work at all. It is
 *   therefore never disabled, and never `aria-checked`: vibe replaces the whole
 *   page with `VibeWorkspace`, so this header is not mounted in vibe and
 *   `current` here can only ever be 'chat' or 'terminal'. Do NOT "fix" this into
 *   a three-way selection — there is nothing to select.
 *
 * Visual language is the app's canonical segmented control (see the footer
 * `ViewToggle`). Native `title` rather than the `Tooltip` wrapper, so disabled
 * segments still explain themselves without a wrapper `<span>` swallowing clicks.
 */
export function TerminalModeSwitch({
  current,
  transport,
  switching,
  enabled,
  showVibe,
  onSelect,
  onVibe,
}: TerminalModeSwitchProps) {
  const { t } = useLingui();
  const labels: Record<TransportMode, string> = { chat: t`Chat`, terminal: t`Terminal` };
  // Gate only the picks that DO transport work. The segment already matching the
  // transport is a pure skin flip, so it stays live mid-turn — that is precisely
  // when someone wants to watch the raw terminal while the agent works.
  const gated = (mode: TransportMode) => switching || (mode !== transport && !enabled);

  return (
    <div
      data-testid="terminal-mode-switch"
      role="radiogroup"
      aria-label={t`Session mode`}
      // State contract read by the switch stress test: the transport gate, the
      // in-flight flag, and which skin is up.
      data-switching={switching}
      data-toggle-enabled={enabled}
      data-chat-active={current === 'chat'}
      className={`${SEGMENTED_GROUP} shrink-0`}
    >
      {(['chat', 'terminal'] as const).map((mode) => {
        const active = mode === current;
        const disabled = gated(mode);
        // The spinner marks the DESTINATION — the segment being switched to.
        const Icon = switching && !active ? Loader2 : ICONS[mode];
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
              switching
                ? t`Switching…`
                : disabled
                  ? t`Available when the agent is waiting for your input`
                  : labels[mode]
            }
            onClick={() => onSelect(mode)}
            className={`${SEGMENTED_BUTTON} ${active ? SEGMENTED_ACTIVE : SEGMENTED_IDLE} ${
              disabled ? 'cursor-not-allowed opacity-50' : ''
            }`}
          >
            <Icon className={`h-3 w-3 ${switching && !active ? 'animate-spin' : ''}`} />
          </button>
        );
      })}
      {showVibe && (
        <button
          type="button"
          role="radio"
          aria-checked={false}
          aria-label={t`Vibe`}
          data-testid="terminal-mode-vibe"
          title={t`Continue in vibe mode`}
          onClick={onVibe}
          className={`${SEGMENTED_BUTTON} ${SEGMENTED_IDLE}`}
        >
          <WandSparkles className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
