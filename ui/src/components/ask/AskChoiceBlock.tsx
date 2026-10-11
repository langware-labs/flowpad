import { Loader2, Terminal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { CopyableCommand } from '@src/components/version-popover/version-popover';
import { cn } from '@src/lib/utils';
import { useRunInTerminal } from '@src/terminal/use-run-in-terminal';
import { AskValueInput } from './AskValueInput';
import type { AskChoice } from './use-ask-question';

/**
 * A question with more than one way to answer it ("a key file, OR sign in with gcloud") —
 * wherever the question is drawn (`AskForm`, `AskModal`, `AskView`).
 *
 * One card per way; the picked card opens its own form. A VALUE way is the ordinary input, sent as
 * `<choice>=<value>` so the op knows which way was taken. A SIGN-IN way has nothing to type and
 * nothing to send: the person runs its command, and the backend — which re-checks by itself —
 * closes the question once the sign-in exists. So this never polls; it only waits.
 */
export function AskChoiceBlock({
  choices = [],
  busy,
  submitLabel,
  onAnswer,
}: {
  /** Absent or empty — every ordinary question — draws nothing. */
  choices?: AskChoice[];
  busy?: boolean;
  /** The op's word for Send, already translated; empty means Send. */
  submitLabel?: ReactNode;
  /** A value way was filled in: `<choice.value>=<typed value>`. */
  onAnswer: (value: string) => void;
}) {
  const { t } = useLingui();
  const runInTerminal = useRunInTerminal();
  const [picked, setPicked] = useState(choices[0]?.value ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  if (!choices.length) return null;

  return (
    <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t`Ways to answer`} data-testid="ask-choices">
      {choices.map((choice) => {
        const on = choice.value === picked;
        const typed = values[choice.value] ?? '';
        const send = () => {
          if (typed && !busy) onAnswer(`${choice.value}=${typed}`);
        };
        return (
          <div
            key={choice.value}
            className={cn('rounded-md border transition-colors', on ? 'border-primary bg-primary/5' : 'hover:bg-muted/60')}
          >
            <button
              type="button"
              role="radio"
              aria-checked={on}
              disabled={busy}
              onClick={() => setPicked(choice.value)}
              className="flex w-full flex-col gap-0.5 px-3 py-2 text-start disabled:cursor-not-allowed disabled:opacity-50"
              data-testid={`ask-choice-${choice.value}`}
            >
              <span className="text-sm">{choice.label || choice.value}</span>
              {choice.hint ? <span className="text-xs text-muted-foreground">{choice.hint}</span> : null}
            </button>

            {on && choice.command ? (
              <div className="flex flex-col gap-2 px-3 pb-3" data-testid="ask-choice-sign-in">
                <div data-testid="ask-choice-command">
                  <CopyableCommand command={choice.command} />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => void runInTerminal(choice.command)}
                    data-testid="ask-choice-run"
                  >
                    <Terminal className="size-3.5" />
                    <Trans>Run in terminal</Trans>
                  </Button>
                  <span className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="ask-choice-waiting">
                    <Loader2 className="size-4 animate-spin" />
                    <Trans>Waiting for the sign-in…</Trans>
                  </span>
                </div>
              </div>
            ) : on ? (
              <div className="flex flex-col gap-2 px-3 pb-3">
                <AskValueInput
                  id={`ask-choice-value-${choice.value}`}
                  testId="ask-choice-input"
                  secret={choice.secret}
                  file={choice.file}
                  value={typed}
                  onChange={(value) => setValues((prev) => ({ ...prev, [choice.value]: value }))}
                  onEnter={send}
                />
                <div>
                  <Button size="sm" disabled={busy || !typed} onClick={send} data-testid="ask-choice-submit">
                    {submitLabel || <Trans>Send</Trans>}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
