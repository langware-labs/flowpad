import { isHubOnly } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { Play } from 'lucide-react';
import { useCallback } from 'react';
import { useInRouterContext } from 'react-router';

import { cn } from '@src/lib/utils';
import { codeBlockCommand } from '@src/terminal/code-block-command';
import { useRunInTerminal } from '@src/terminal/use-run-in-terminal';

interface CodeBlockRunButtonProps {
  language: string;
  /** Read at click time — the block's text is only known once it rendered. */
  code: () => string;
  className?: string;
}

/**
 * Run a markdown code block in a terminal (`useRunInTerminal`): the project's
 * open shell tab when there is one, a new shell tab otherwise.
 *
 * Renders nothing where there is no terminal to run in: a non-runnable
 * language, the hub (no compute node), or a markdown surface mounted outside
 * the router.
 */
export function CodeBlockRunButton(props: CodeBlockRunButtonProps) {
  const inRouter = useInRouterContext();
  if (!inRouter || isHubOnly() || !codeBlockCommand(props.language, 'x')) return null;
  return <RunButton {...props} />;
}

function RunButton({ language, code, className }: CodeBlockRunButtonProps) {
  const { t } = useLingui();
  const runInTerminal = useRunInTerminal();

  const run = useCallback(async () => {
    const command = codeBlockCommand(language, code());
    if (command) await runInTerminal(command);
  }, [language, code, runInTerminal]);

  return (
    <button
      type="button"
      data-testid="code-block-run"
      title={t`Run in terminal`}
      aria-label={t`Run in terminal`}
      onClick={() => void run()}
      className={cn('flex items-center gap-1', className)}
    >
      <Play className="h-3 w-3" />
      <span>{t`Run`}</span>
    </button>
  );
}
