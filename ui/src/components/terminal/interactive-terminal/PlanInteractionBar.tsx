import { FlowData, FlowElementTypes } from '@sdk';
import { MarkdownView } from '@src/components/markdown-view';
import { cn } from '@src/lib/utils';
import { ClipboardCheck, ListChecks, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useChatPlanMode } from './chat-plan-mode-context';

interface PlanInteractionBarProps {
  /** The live FlowData stream items (same array SimpleChatPane renders). */
  items: FlowData[];
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
 * AskUserQuestion / ExitPlanMode tool call that the user hasn't responded to yet
 * (no USER_MESSAGE after it). Returns null when there's nothing to act on.
 */
function findPending(items: FlowData[]): Pending {
  let lastUserIdx = -1;
  let hit: { idx: number; name: string; fd: FlowData } | null = null;
  items.forEach((it, i) => {
    const et = it.elementType;
    if (et === FlowElementTypes.USER_MESSAGE) lastUserIdx = i;
    if (et === FlowElementTypes.TOOL_CALL) {
      const name = it.attributes['tool-name'];
      if (name === 'AskUserQuestion' || name === 'ExitPlanMode') hit = { idx: i, name, fd: it };
    }
  });
  if (!hit) return null;
  if (lastUserIdx > hit.idx) return null; // already answered / moved on
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
 * sends it as the next headless turn (the "insert a prompt + Enter" path).
 */
export function PlanInteractionBar({ items }: PlanInteractionBarProps) {
  const { enabled, sending, answer, execute, setPlanPending } = useChatPlanMode();
  const pending = useMemo(() => findPending(items), [items]);

  // "Switch back to code" once a plan is ready.
  useEffect(() => {
    if (pending?.kind === 'plan') setPlanPending(false);
  }, [pending?.kind, setPlanPending]);

  if (!enabled || !pending) return null;

  return (
    <div className="border-t bg-background px-4 py-3" data-testid="plan-interaction-bar">
      {pending.kind === 'question' ? (
        <QuestionCard questions={pending.questions} sending={sending} onSubmit={answer} />
      ) : (
        <PlanReadyCard plan={pending.plan} sending={sending} onExecute={execute} />
      )}
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
