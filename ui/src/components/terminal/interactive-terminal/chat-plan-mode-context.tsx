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
 * TWO gates, deliberately separate — one flag serving both is the bug this
 * split fixes. SENDING a plan turn needs the headless transport (the per-turn
 * `permission_mode` is only read on the print-mode branch of `_http_prompt`;
 * the PTY branch routes to `_run_pty_prompt` before it is ever consulted), so
 * the pill stays headless-gated. RESPONDING to a question the agent already
 * asked needs nothing of the sort — the answer is an ordinary `prompt()`, which
 * the backend routes by transport on its own. Gating the cards on the transport
 * too meant a chat surface sitting on a PTY worker (the normal state once a
 * session has visited the terminal — reconciliation is one-directional, see
 * docs/viewmodes.md) silently dropped every AskUserQuestion.
 */
interface ChatPlanModeValue {
  /** The plan pill / Shift+Tab. Headless (`pty_mode===false`) + capable worker
   *  only: no other transport can carry `--permission-mode plan`. */
  planToggleEnabled: boolean;
  /** The question / Execute cards. Transport-agnostic: answering is a plain
   *  turn, so the only requirement is a process to send it to. */
  respondEnabled: boolean;
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
  planPending: false,
  togglePlan: () => {},
  setPlanPending: () => {},
  sending: false,
  answer: async () => {},
  execute: async () => {},
};

const Ctx = createContext<ChatPlanModeValue | null>(null);

export function ChatPlanModeProvider({ process, children }: { process: AgenticProcess | null; children: ReactNode }) {
  const planToggleEnabled = !!process && process.isHeadless && !!process.supports_plan_mode;
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
    () => ({ planToggleEnabled, respondEnabled, planPending, togglePlan, setPlanPending, sending, answer, execute }),
    [planToggleEnabled, respondEnabled, planPending, togglePlan, sending, answer, execute],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read plan-mode state. Returns inert defaults outside a provider. */
export function useChatPlanMode(): ChatPlanModeValue {
  return useContext(Ctx) ?? FALLBACK;
}
