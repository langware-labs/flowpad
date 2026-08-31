import { t } from '@lingui/core/macro';
import { AgenticProcess, type PermissionMode } from '@sdk';
import { notify } from '@src/notifications/notify';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Shared "plan mode" state for the chat surface. The composer (ChatComposerBar)
 * owns the toggle/pill; the plan-interaction bar (PlanInteractionBar) owns the
 * question/Execute cards. Both need the same `planPending` flag and the same
 * `process.prompt(...)` wiring, so it lives in one context provided around the
 * whole InteractiveTerminal subtree.
 *
 * "mode" here is NOT a live process state — it is just which `--permission-mode`
 * the next headless turn is sent with: `plan` (read-only) while the toggle is
 * on, the process's normal configured mode otherwise. See the plan doc.
 *
 * THREE flags, because "can the user act on this here?" has three different
 * answers and one flag serving all of them is the bug this split fixes.
 *
 * A chat surface can be sitting on a PTY worker — the normal state once a
 * session has visited the terminal, since reconciliation is one-directional
 * (docs/viewmodes.md). What that transport can and cannot do:
 *
 *  - SENDING a plan turn needs headless. The per-turn `permission_mode` is read
 *    only on the print-mode branch of `_http_prompt`; the PTY branch returns
 *    `_run_pty_prompt` before it is ever consulted, so the pill would be a lie.
 *  - ANSWERING a pending question inline ALSO needs headless, but for a
 *    different reason, and it took a live experiment to establish: on a PTY
 *    worker the answer is pasted into a TUI that is blocked on its own question
 *    picker. The backend rejects the turn (`submission-error` /
 *    `user-turn-not-landed`) AND the prose is consumed as keystrokes, toggling
 *    checkboxes and marking questions answered in the picker the user has to
 *    come back to. Worse than a no-op, so the card must not offer it.
 *  - KNOWING a question is pending needs neither. That is `respondEnabled`, and
 *    it is what keeps a PTY-backed chat from showing an idle worker with an
 *    unexplained "Asking a question" chip — it renders a read-only notice
 *    pointing at the terminal instead.
 */
interface ChatPlanModeValue {
  /** The plan pill / Shift+Tab. Headless (`pty_mode===false`) + capable worker
   *  only: no other transport can carry `--permission-mode plan`. */
  planToggleEnabled: boolean;
  /** There is a session that could have a pending interaction — the bar may
   *  render something. Transport-agnostic. */
  respondEnabled: boolean;
  /** Whether an answer submitted HERE actually reaches the agent. Headless
   *  only: on a PTY worker the turn is rejected and the paste corrupts the
   *  TUI's own picker, so the bar degrades to a read-only notice. */
  canAnswerInline: boolean;
  /** The next manual send goes out as a read-only `plan` turn. */
  planPending: boolean;
  togglePlan: () => void;
  setPlanPending: (v: boolean) => void;
  /** True while an answer/execute send started here is in flight. */
  sending: boolean;
  /** Answer an AskUserQuestion as the next turn (stays in plan mode if pending). */
  answer: (text: string) => Promise<void>;
  /** Approve + run the plan in the process's normal mode, then leave plan mode. */
  execute: () => Promise<void>;
}

const FALLBACK: ChatPlanModeValue = {
  planToggleEnabled: false,
  respondEnabled: false,
  canAnswerInline: false,
  planPending: false,
  togglePlan: () => {},
  setPlanPending: () => {},
  sending: false,
  answer: async () => {},
  execute: async () => {},
};

const Ctx = createContext<ChatPlanModeValue | null>(null);

export function ChatPlanModeProvider({
  process,
  children,
}: {
  // InteractiveTerminal's `process` is optional; every read below is guarded by
  // `!!process`, so absent and null behave identically here.
  process: AgenticProcess | null | undefined;
  children: ReactNode;
}) {
  const canAnswerInline = !!process && process.isHeadless;
  const planToggleEnabled = canAnswerInline && !!process.supports_plan_mode;
  const respondEnabled = !!process;
  const [planPending, setPlanPending] = useState(false);
  const [sending, setSending] = useState(false);

  const togglePlan = useCallback(() => setPlanPending((v) => !v), []);

  const send = useCallback(
    async (text: string, permissionMode?: PermissionMode) => {
      if (!process) return;
      setSending(true);
      try {
        await process.prompt(text, undefined, permissionMode ? { permissionMode } : undefined);
      } catch (err) {
        console.error('[ChatPlanMode] send failed', err);
        notify.error({ title: t`Message not sent`, message: err instanceof Error ? err.message : String(err) });
      } finally {
        setSending(false);
      }
    },
    [process],
  );

  const answer = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;
      // Answering keeps the plan turn read-only so planning continues.
      await send(t, planPending ? 'plan' : undefined);
    },
    [send, planPending],
  );

  const execute = useCallback(async () => {
    // Approve: run in the process's normal configured mode (no override) and
    // leave plan mode so the next manual send is a normal turn too.
    await send('Implement the approved plan.');
    setPlanPending(false);
  }, [send]);

  const value = useMemo<ChatPlanModeValue>(
    () => ({
      planToggleEnabled,
      respondEnabled,
      canAnswerInline,
      planPending,
      togglePlan,
      setPlanPending,
      sending,
      answer,
      execute,
    }),
    [planToggleEnabled, respondEnabled, canAnswerInline, planPending, togglePlan, sending, answer, execute],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read plan-mode state. Returns inert defaults outside a provider. */
export function useChatPlanMode(): ChatPlanModeValue {
  return useContext(Ctx) ?? FALLBACK;
}
