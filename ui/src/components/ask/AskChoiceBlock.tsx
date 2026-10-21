import { LogIn, Loader2, Play } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Shell } from '@sdk';
import { useProviderSignIn } from '@src/components/oauth/use-provider-sign-in';
import { errorMessage } from '@src/lib/error-message';
import { ShellTerminal } from '@src/components/terminal/interactive-terminal/ShellTerminal';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { AskValueInput } from './AskValueInput';
import type { AskChoice } from './use-ask-question';

/**
 * A question with more than one way to answer it ("a key file, OR sign in with gcloud") —
 * wherever the question is drawn (`AskForm`, `AskModal`, `AskView`).
 *
 * One card per way, the first one picked; the picked card opens its own form. A VALUE way is the ordinary
 * input, sent as `<choice>=<value>` so the op knows which way was taken; a way of several values (`fields`) is
 * one input per field, sent once all are filled as newline-joined `<field>=<value>` lines. A SIGN-IN way has nothing to type and
 * nothing to send: Run starts its command in a terminal of its own, drawn right here under the
 * choice (the person may have to answer it — a browser sign-in, a prompt), and the backend — which
 * re-checks by itself — closes the question once the sign-in exists. So this never polls. A SIGN-IN
 * THROUGH FLOWPAD way (`provider`) is the screen's own connect, in this browser — the same one the
 * source setup's sign-in uses; once the grant lands the way is answered by its name alone.
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
  /** A value way was filled in: `<choice.value>=<typed value>` (a line per field for a way of several). */
  onAnswer: (value: string) => void;
}) {
  const { t } = useLingui();
  const [picked, setPicked] = useState(choices[0]?.value ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  /** The terminal a sign-in way's command runs in, per choice, once Run was pressed. */
  const [shells, setShells] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<string | null>(null);
  const run = async (choice: AskChoice) => {
    setRunning(choice.value);
    try {
      const shell = await Shell.belongingTo(`ask-choice:${choice.value}`, { name: choice.label || choice.value });
      await shell.ensureStarted();
      setShells((prev) => ({ ...prev, [choice.value]: shell.id }));
      await shell.sendInput(`${choice.command}\r`);
    } finally {
      setRunning(null);
    }
  };
  if (!choices.length) return null;

  return (
    <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t`Ways to answer`} data-testid="ask-choices">
      {choices.map((choice) => {
        const on = choice.value === picked;
        const multi = !!choice.fields?.length;
        const fields = multi ? choice.fields! : [choice];
        const typedOf = (field: AskChoice) => values[`${choice.value}/${field.value}`] ?? '';
        const filled = fields.every((field) => typedOf(field));
        const send = () => {
          if (filled && !busy) onAnswer(fields.map((field) => `${field.value}=${typedOf(field)}`).join('\n'));
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

            {on && choice.provider ? (
              <AskChoiceSignIn choice={choice} busy={busy} onAnswer={onAnswer} />
            ) : on && choice.command ? (
              <div className="flex flex-col gap-2 px-3 pb-3" data-testid="ask-choice-sign-in">
                <code className="rounded bg-muted px-2 py-1.5 text-xs" data-testid="ask-choice-command">
                  {choice.command}
                </code>
                {shells[choice.value] ? (
                  <>
                    <div className="h-40 overflow-hidden rounded border" data-testid="ask-choice-terminal">
                      <ShellTerminal shellId={shells[choice.value]} active className="h-full" />
                    </div>
                    <span className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="ask-choice-waiting">
                      <Loader2 className="size-4 animate-spin" />
                      <Trans>Checking once it finishes…</Trans>
                    </span>
                  </>
                ) : (
                  <Button
                    className="gap-1.5 self-start"
                    disabled={busy || running === choice.value}
                    onClick={() => void run(choice)}
                    data-testid="ask-choice-run"
                  >
                    <Play className="size-3.5" />
                    <Trans>Run</Trans>
                  </Button>
                )}
              </div>
            ) : on ? (
              <div className="flex flex-col gap-2 px-3 pb-3">
                {fields.map((field) => {
                  const id = `ask-choice-value-${choice.value}-${field.value}`;
                  return (
                    <div key={field.value} className="flex flex-col gap-1">
                      {multi ? (
                        <label htmlFor={id} className="text-xs text-muted-foreground">
                          {field.label || field.value}
                        </label>
                      ) : null}
                      <AskValueInput
                        id={id}
                        testId={multi ? `ask-choice-input-${field.value}` : 'ask-choice-input'}
                        secret={field.secret}
                        file={field.file}
                        placeholder={field.placeholder}
                        value={typedOf(field)}
                        onChange={(value) => setValues((prev) => ({ ...prev, [`${choice.value}/${field.value}`]: value }))}
                        onEnter={send}
                      />
                      {field.help_url ? (
                        <a
                          href={field.help_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-primary hover:underline"
                          data-testid={`ask-choice-help-${field.value}`}
                        >
                          <Trans>Create one at {shownUrl(field.help_url)}</Trans> ↗
                        </a>
                      ) : null}
                      {multi && field.hint ? (
                        <span className="text-xs text-muted-foreground">{field.hint}</span>
                      ) : null}
                    </div>
                  );
                })}
                <div>
                  <Button size="sm" disabled={busy || !filled} onClick={send} data-testid="ask-choice-submit">
                    {submitLabel || <Trans>Continue</Trans>}
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

/** A sign-in-through-Flowpad way: connect its provider in this browser; once the grant lands, the way is answered
 *  by its name alone — the backend stores nothing for it, and remembers it as the way set up. */
function AskChoiceSignIn({ choice, busy, onAnswer }: { choice: AskChoice; busy?: boolean; onAnswer: (value: string) => void }) {
  const { t } = useLingui();
  const [refused, setRefused] = useState('');
  const { connecting, signIn } = useProviderSignIn(choice.provider ?? '', {
    onGranted: () => onAnswer(choice.value),
    onNotFinished: () => setRefused(t`The sign-in did not finish.`),
    onError: (e) => setRefused(errorMessage(e, t`Could not start the sign-in.`)),
  });
  return (
    <div className="flex flex-col gap-2 px-3 pb-3" data-testid="ask-choice-oauth">
      <Button
        className="gap-1.5 self-start"
        disabled={busy || connecting}
        onClick={() => {
          setRefused('');
          void signIn();
        }}
        data-testid="ask-choice-sign-in-button"
      >
        {connecting ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />}
        <Trans>Sign in</Trans>
      </Button>
      {connecting && (
        <span className="text-sm text-muted-foreground" data-testid="ask-choice-oauth-waiting">
          <Trans>Finish signing in in the browser window that opened…</Trans>
        </span>
      )}
      {refused && (
        <span className="text-sm" data-testid="ask-choice-oauth-refused">
          {refused}
        </span>
      )}
    </div>
  );
}

/** A help link as a person reads it: no scheme, no trailing slash. */
function shownUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
