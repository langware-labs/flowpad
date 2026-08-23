import { FlowData, FlowElementTypes } from '@sdk';
import { MarkdownView } from '@src/components/markdown-view';
import { cn } from '@src/lib/utils';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { setViewMode, ViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation';
import { ClipboardCheck, ListChecks, Play, Terminal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getToolUseId } from '@src/components/floating-chat/groupTurnEvents';
import { useChatPlanMode } from './chat-plan-mode-context';

interface PlanInteractionBarProps {
  /** The live FlowData stream items (same array SimpleChatPane renders). */
  items: FlowData[];
  /**
   * May this surface offer the interactive picker at all? False for the
   * EntityExecutionPanel surfaces (vibe chat, floating chat, asset-editor run
   * panels), which show only the terminal notice — a deliberate product call,
   * not a capability one. They then render NOTHING on a headless worker, where
   * the plain composer below already takes the answer.
   */
  allowPicker?: boolean;
}

interface QuestionOption {
  label: string;
  description?: string;
}
interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

type Pending =
  | { kind: 'question'; questions: Question[] }
  | { kind: 'plan'; plan: string }
  | null;

/** Pull the structured tool input off a TOOL_CALL FlowData (`data.input`/`.args`). */
function toolInput(fd: FlowData): Record<string, unknown> {
  const data = fd.data as { input?: unknown; args?: unknown } | undefined;
  const raw = (data?.input ?? data?.args) as Record<string, unknown> | undefined;
  return raw && typeof raw === 'object' ? raw : {};
}

/**
 * Find the latest still-pending plan interaction in the stream: the most recent
 * AskUserQuestion / ExitPlanMode tool call the user hasn't responded to yet.
 * Returns null when there's nothing to act on.
 *
 * TWO independent "it's been answered" signals, because the two transports
 * record an answer differently and each misses the other's case:
 *
 *  - A **TOOL_RESULT paired by `tool_use_id`**. This is how the provider itself
 *    closes the question — answering in the TUI writes only that (a `user`
 *    entry carrying a `tool_result` block, which the analyzer maps to
 *    TOOL_RESULT, never to USER_MESSAGE). Without this check a question
 *    answered in the terminal stayed on screen forever once the chat surface
 *    started rendering the card on a PTY worker. Same rule the backend's
 *    `_pending_user_input_tool` (worker_status.py) uses to clear PENDING_USER.
 *  - A **later USER_MESSAGE**. The headless flow answers by sending a fresh
 *    turn, and that turn's tool_use may never receive a result at all (the
 *    turn ended at the question), so pairing alone would never clear it.
 */
function findPending(items: FlowData[]): Pending {
  let lastUserIdx = -1;
  let hit: { idx: number; name: string; fd: FlowData } | null = null;
  const resolved = new Set<string>();
  items.forEach((it, i) => {
    const et = it.elementType;
    if (et === FlowElementTypes.USER_MESSAGE) lastUserIdx = i;
    if (et === FlowElementTypes.TOOL_RESULT) {
      const id = getToolUseId(it);
      if (id) resolved.add(id);
    }
    if (et === FlowElementTypes.TOOL_CALL) {
      const name = it.attributes['tool-name'];
      if (name === 'AskUserQuestion' || name === 'ExitPlanMode') hit = { idx: i, name, fd: it };
    }
  });
  if (!hit) return null;
  if (lastUserIdx > hit.idx) return null; // answered by a follow-up turn / moved on
  const hitId = getToolUseId(hit.fd);
  if (hitId && resolved.has(hitId)) return null; // the provider closed it (TUI answer)
  if (hit.name === 'AskUserQuestion') {
    const qs = toolInput(hit.fd).questions;
    const questions = Array.isArray(qs) ? (qs as Question[]) : [];
    if (questions.length === 0) return null;
    return { kind: 'question', questions };
  }
  const plan = String(toolInput(hit.fd).plan ?? '');
  return { kind: 'plan', plan };
}

/**
 * Sticky action area below the chat stream: renders the structured choice card
 * for an AskUserQuestion, or a "Plan ready → Execute" card for ExitPlanMode.
 * Submitting an answer / executing routes through {@link useChatPlanMode}, which
 * sends it as the next turn (the "insert a prompt + Enter" path).
 *
 * Two renderings, picked by `canAnswerInline` (see the flag notes in
 * `chat-plan-mode-context`):
 *
 *  - Headless: the interactive cards. A submit is an ordinary `prompt()` turn.
 *  - PTY: a read-only notice pointing at the terminal. The agent's own TUI is
 *    blocked on its picker there, so an answer sent from here is rejected
 *    (`user-turn-not-landed`) and its text is eaten as keystrokes by that
 *    picker. The user still needs to KNOW a question is waiting — that is the
 *    whole reason the bar renders at all on this transport.
 */
export function PlanInteractionBar({ items, allowPicker = true }: PlanInteractionBarProps) {
  const { respondEnabled, canAnswerInline, sending, answer, execute, setPlanPending } = useChatPlanMode();
  const pending = useMemo(() => findPending(items), [items]);

  // "Switch back to code" once a plan is ready.
  useEffect(() => {
    if (pending?.kind === 'plan') setPlanPending(false);
  }, [pending?.kind, setPlanPending]);

  if (!respondEnabled || !pending) return null;

  // Headless + picker suppressed: the composer under this bar answers fine, and
  // pointing at a terminal this session does not have would be a lie.
  if (canAnswerInline && !allowPicker) return null;

  return (
    <div className="border-t bg-background px-4 py-3" data-testid="plan-interaction-bar">
      {!canAnswerInline ? (
        <AnswerInTerminalNotice kind={pending.kind} />
      ) : pending.kind === 'question' ? (
        <QuestionCard questions={pending.questions} sending={sending} onSubmit={answer} />
      ) : (
        <PlanReadyCard plan={pending.plan} sending={sending} onExecute={execute} />
      )}
    </div>
  );
}

/**
 * The PTY rendering: say what is waiting and where to deal with it. No control,
 * deliberately — every action available here would be delivered by pasting into
 * the agent's blocked TUI, which does not answer it and does corrupt it.
 */
function AnswerInTerminalNotice({ kind }: { kind: 'question' | 'plan' }) {
  const { currentDock, navigation } = useDockNavigation();

  // URL-first, the same two branches as the footer ViewToggle's `select`: on a
  // dock route the URL carries the mode and is authoritative in the render that
  // commits it, so the click must NAVIGATE — writing the preference alone left
  // `?viewMode=` untouched and the surface never changed. Only a pointerless
  // route (no dock URL to carry the mode) sets the preference directly.
  const openTerminal = () => {
    if (currentDock) navigation.openDock(currentDock.withViewMode(ViewMode.Advanced));
    else setViewMode(ViewMode.Advanced);
  };

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-foreground"
      data-testid="answer-in-terminal-notice"
    >
      <Terminal className="h-4 w-4 flex-shrink-0 text-blue-400" />
      <span className="min-w-0 flex-1">
        {kind === 'question'
          ? t`The agent has asked a question — answer it in the terminal.`
          : t`The agent's plan is ready — approve it in the terminal.`}
      </span>
      <button
        type="button"
        // Advanced is the terminal surface, so this lands the user on this
        // session's xterm — where the agent's own picker is waiting. The
        // transport is already PTY here, so `useProcessSurface` reconciles to a
        // no-op rather than starting anything.
        onClick={openTerminal}
        className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        data-testid="answer-in-terminal-open"
      >
        <Terminal className="h-3.5 w-3.5" />
        <Trans>Open terminal</Trans>
      </button>
    </div>
  );
}

function QuestionCard({
  questions,
  sending,
  onSubmit,
}: {
  questions: Question[];
  sending: boolean;
  onSubmit: (text: string) => void | Promise<void>;
}) {
  // selections[qIdx] = set of chosen option labels for that question.
  const [selections, setSelections] = useState<Record<number, string[]>>({});

  const choose = (qIdx: number, label: string, multi: boolean) => {
    setSelections((prev) => {
      const cur = prev[qIdx] ?? [];
      if (multi) {
        const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
        return { ...prev, [qIdx]: next };
      }
      return { ...prev, [qIdx]: [label] };
    });
  };

  const ready = questions.every((_, i) => (selections[i]?.length ?? 0) > 0);

  const submit = () => {
    const text = questions
      .map((q, i) => {
        const picked = selections[i] ?? [];
        const label = q.header || q.question;
        return `${label}: ${picked.join(', ')}`;
      })
      .join('\n');
    void onSubmit(text);
    setSelections({});
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
        <ListChecks className="h-4 w-4 text-blue-400" />
        {questions.length === 1 ? 'The agent has a question' : `The agent has ${questions.length} questions`}
      </div>
      {questions.map((q, qIdx) => (
        <div key={qIdx} className="flex flex-col gap-1.5">
          <div className="text-[13px] text-foreground">{q.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((opt) => {
              const active = (selections[qIdx] ?? []).includes(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  title={opt.description}
                  disabled={sending}
                  onClick={() => choose(qIdx, opt.label, !!q.multiSelect)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-[12px] transition-colors disabled:opacity-50',
                    active
                      ? 'border-blue-400 bg-blue-400/15 text-blue-300'
                      : 'border-border/60 text-muted-foreground hover:border-blue-400/50 hover:text-foreground',
                  )}
                  data-testid="plan-question-option"
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex justify-end">
        <button
          type="button"
          disabled={!ready || sending}
          onClick={submit}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="plan-question-submit"
        >
          <ClipboardCheck className="h-3.5 w-3.5" />
          Submit answer
        </button>
      </div>
    </div>
  );
}

function PlanReadyCard({
  plan,
  sending,
  onExecute,
}: {
  plan: string;
  sending: boolean;
  onExecute: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[13px] font-medium text-foreground hover:text-blue-300"
        >
          <ClipboardCheck className="h-4 w-4 text-blue-400" />
          Plan ready{plan ? (open ? ' — hide' : ' — review') : ''}
        </button>
        <button
          type="button"
          disabled={sending}
          onClick={() => void onExecute()}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="plan-execute"
        >
          <Play className="h-3.5 w-3.5" />
          Execute
        </button>
      </div>
      {open && plan && (
        <div className="max-h-60 overflow-y-auto rounded-md border border-border/60 bg-muted/30 p-2 text-[12px]">
          <MarkdownView value={plan} compact codeChrome={false} />
        </div>
      )}
    </div>
  );
}
