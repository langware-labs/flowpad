/**
 * What an automation does, step by step, each with a way to open what it acts
 * on: the agent it runs, the wizard it opens, the script it starts. A built-in
 * step says what it does in words. Clicks only navigate (URL-first).
 */
import { Trans } from '@lingui/react/macro';
import { TypeId, type ThenPart } from '@sdk';
import { ExternalLink } from 'lucide-react';
import { Fragment } from 'react';
import { ContextEntityChip } from '@src/components/conversation/EntityChip';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useAutomationWords } from './automation-words';

/** One step in words. A process it runs is a chip that opens the session, and "prompt" opens the
 *  prompt it is given; every other step is its plain sentence. */
export function StepText({ part }: { part: ThenPart }) {
  const words = useAutomationWords();
  if (part.kind !== 'run_process' || !part.target) return <>{words.then(part)}</>;
  return (
    <span data-testid="then-run-process">
      <Trans>
        run process <ContextEntityChip typeId={new TypeId(part.target)} size="inline" /> with{' '}
        <Popover>
          <PopoverTrigger className="underline underline-offset-2 hover:text-primary" data-testid="then-prompt-open">
            prompt
          </PopoverTrigger>
          <PopoverContent align="start" className="max-w-md whitespace-pre-wrap text-sm" data-testid="then-prompt-text">
            {part.prompt}
          </PopoverContent>
        </Popover>
      </Trans>
    </span>
  );
}

/** Every step on one line — a folded "Then" block. */
export function ThenLine({ steps }: { steps: ThenPart[] }) {
  return (
    <>
      {steps.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && ', '}
          <StepText part={part} />
        </Fragment>
      ))}
    </>
  );
}

const EDITOR_FOR: Partial<Record<ThenPart['kind'], string>> = { run_agent: 'agent', open_wizard: 'wizard' };

export function ThenSteps({ steps }: { steps: ThenPart[] }) {
  const words = useAutomationWords();
  const { navigation } = useDockNavigation();

  const opener = (p: ThenPart): (() => void) | null => {
    const editor = EDITOR_FOR[p.kind];
    if (editor && p.target?.startsWith(`${editor}-`)) {
      return () => navigation.openDock(DockPointer.forAssetEditorByTypeId(editor, new TypeId(p.target as string)));
    }
    if (p.kind === 'run_script' && p.target_name?.startsWith('/')) {
      return () => navigation.openMachinePath(p.target_name as string, LOCAL_COMPUTE_NODE);
    }
    return null;
  };

  return (
    <ul className="flex flex-col gap-2 text-sm" data-testid="then-steps">
      {steps.map((p, i) => {
        const open = opener(p);
        return (
          <li key={i} className="flex flex-col gap-0.5" data-step-kind={p.kind}>
            <span className="flex flex-wrap items-center gap-2">
              <span className="first-letter:uppercase">
                <StepText part={p} />
              </span>
              {open && (
                <button
                  type="button"
                  onClick={open}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  data-testid={`then-step-open-${i}`}
                >
                  <ExternalLink className="size-3" aria-hidden />
                  {p.kind === 'run_script' ? <Trans>Open the script</Trans> : <Trans>Open it</Trans>}
                </button>
              )}
            </span>
            {p.detail && <span className="text-xs text-muted-foreground">{p.detail}</span>}
            {p.prompt && p.kind !== 'run_process' && (
              <span className="text-xs text-muted-foreground">“{p.prompt}”</span>
            )}
            {p.problem && (
              <span className="w-fit rounded border border-amber-500/50 bg-amber-500/10 px-1.5 text-xs">
                {p.problem}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
