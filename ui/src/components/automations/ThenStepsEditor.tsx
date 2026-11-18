/**
 * A message rule's THEN as a list of steps the person builds: each step a row with its number, its
 * kind, its own fields, and move / remove buttons; "Add step" offers the four kinds.
 *
 * The steps are the SDK's `RuleStep[]` (`thenOfSteps` / `stepsOfThen` turn them into the rule's `then`
 * and back). Nothing is saved here — every edit is one `onChange` with the whole new list.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { RuleStep, RuleStepKind } from '@sdk';
import { ArrowDown, ArrowUp, Bot, MailOpen, MessageSquareText, Plus, Terminal, X, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Textarea } from '@src/components/ui/textarea';

export const STEP_KINDS: readonly RuleStepKind[] = ['mark_read', 'run_script', 'run_agent', 'prompt'];
const ICONS: Record<RuleStepKind, LucideIcon> = { mark_read: MailOpen, run_script: Terminal, run_agent: Bot, prompt: MessageSquareText };

/** What the steps still need before the rule can be saved: 'steps' (none yet), 'agent', 'prompt', 'script'. */
export function missingInSteps(steps: RuleStep[]): string[] {
  const missing = new Set<string>();
  if (!steps.length) missing.add('steps');
  for (const step of steps) {
    if (step.kind === 'run_agent' && !step.agent) missing.add('agent');
    if ((step.kind === 'run_agent' || step.kind === 'prompt') && !step.prompt?.trim()) missing.add('prompt');
    if (step.kind === 'run_script' && !step.script?.trim()) missing.add('script');
  }
  return [...missing];
}

/** Each kind's name, and the one line the menu says about it. */
export function useStepKindWords(): Record<RuleStepKind, { name: string; hint: string }> {
  const { t } = useLingui();
  return {
    mark_read: { name: t`Mark as read`, hint: t`the message stops showing as new` },
    run_script: { name: t`Run a script`, hint: t`a command in the project folder` },
    run_agent: { name: t`Run an agent`, hint: t`gets the message, can reply` },
    prompt: { name: t`Prompt`, hint: t`a worker runs it` },
  };
}

export function ThenStepsEditor({
  steps,
  onChange,
  disabled,
  agents,
}: {
  steps: RuleStep[];
  onChange: (steps: RuleStep[]) => void;
  disabled?: boolean;
  agents: Array<{ id: string; name?: string | null }>;
}) {
  const { t } = useLingui();
  const words = useStepKindWords();
  const [menu, setMenu] = useState(false);
  const patch = (index: number, change: Partial<RuleStep>) =>
    onChange(steps.map((step, i) => (i === index ? { ...step, ...change } : step)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...steps];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    onChange(next);
  };
  const iconButton = 'grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30';

  return (
    <div className="flex flex-col gap-2" data-testid="rule-steps">
      {steps.map((step, i) => {
        const Icon = ICONS[step.kind];
        const number = i + 1;
        // The first step, when it runs an agent, keeps the ids the one-agent screen had.
        const legacy = i === 0 && step.kind === 'run_agent';
        const promptBox = (
          <Textarea
            value={step.prompt ?? ''}
            onChange={(e) => patch(i, { prompt: e.target.value })}
            disabled={disabled}
            rows={3}
            placeholder={t`confirm which charge is in question, explain the refund path, and draft the reply. Don’t send it.`}
            className="text-sm"
            data-testid={legacy ? 'message-rule-prompt' : `rule-step-prompt-${i}`}
          />
        );
        return (
          <div key={i} className="flex flex-col gap-2 rounded-md border border-border p-2" data-testid={`rule-step-${i}`} data-kind={step.kind}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-4 text-center text-xs tabular-nums text-muted-foreground">{number}</span>
              <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="font-medium">{words[step.kind].name}</span>
              {step.kind === 'run_agent' && (
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                  value={step.agent ?? ''}
                  onChange={(e) => patch(i, { agent: e.target.value })}
                  disabled={disabled}
                  data-testid={legacy ? 'message-rule-agent' : `rule-step-agent-${i}`}
                >
                  <option value="">{t`Pick an agent…`}</option>
                  {/* A saved agent that is not offered here (it runs elsewhere) stays shown as itself. */}
                  {step.agent && !agents.some((a) => `agent-${a.id}` === step.agent) && <option value={step.agent}>{step.agent}</option>}
                  {agents.map((a) => (
                    <option key={a.id} value={`agent-${a.id}`}>
                      {a.name}
                    </option>
                  ))}
                </select>
              )}
              {step.kind === 'run_script' && (
                <Input
                  value={step.script ?? ''}
                  onChange={(e) => patch(i, { script: e.target.value })}
                  disabled={disabled}
                  placeholder={t`./open-ticket.sh`}
                  className="h-8 min-w-0 flex-1 font-mono text-xs"
                  data-testid={`rule-step-script-${i}`}
                />
              )}
              <span className="flex-1" />
              {!disabled && (
                <span className="flex items-center gap-0.5">
                  <button type="button" className={iconButton} disabled={i === 0} onClick={() => move(i, -1)} aria-label={t`Move step ${number} up`} data-testid={`rule-step-up-${i}`}>
                    <ArrowUp className="size-3.5" aria-hidden />
                  </button>
                  <button type="button" className={iconButton} disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label={t`Move step ${number} down`} data-testid={`rule-step-down-${i}`}>
                    <ArrowDown className="size-3.5" aria-hidden />
                  </button>
                  <button type="button" className={iconButton} onClick={() => onChange(steps.filter((_, at) => at !== i))} aria-label={t`Remove step ${number}`} data-testid={`rule-step-remove-${i}`}>
                    <X className="size-3.5" aria-hidden />
                  </button>
                </span>
              )}
            </div>
            {(step.kind === 'run_agent' || step.kind === 'prompt') && promptBox}
          </div>
        );
      })}
      {!disabled && (
        <Popover open={menu} onOpenChange={setMenu}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="w-fit gap-1" data-testid="rule-step-add">
              <Plus className="size-3.5" aria-hidden />
              <Trans>Add step</Trans>
            </Button>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="start" className="w-72 p-1" data-testid="rule-step-menu">
            {STEP_KINDS.map((kind) => {
              const Icon = ICONS[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    onChange([...steps, { kind }]);
                    setMenu(false);
                  }}
                  data-testid={`rule-step-kind-${kind}`}
                >
                  <Icon className="size-3.5 shrink-0 self-center text-muted-foreground" aria-hidden />
                  <span className="whitespace-nowrap">{words[kind].name}</span>
                  <span className="truncate text-xs text-muted-foreground">· {words[kind].hint}</span>
                </button>
              );
            })}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
