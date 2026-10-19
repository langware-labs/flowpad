/**
 * What an automation does, step by step, each with a way to open what it acts
 * on: the agent it runs, the wizard it opens, the script it starts. A built-in
 * step says what it does in words. Clicks only navigate (URL-first).
 */
import { Trans } from '@lingui/react/macro';
import { TypeId, type ThenPart } from '@sdk';
import { ExternalLink } from 'lucide-react';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useAutomationWords } from './automation-words';

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
              <span className="first-letter:uppercase">{words.then(p)}</span>
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
            {p.prompt && <span className="text-xs text-muted-foreground">“{p.prompt}”</span>}
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
