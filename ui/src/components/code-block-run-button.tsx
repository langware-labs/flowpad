import { dataContext, isHubOnly, Shell, tabManager } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { Play } from 'lucide-react';
import { useCallback } from 'react';
import { useInRouterContext } from 'react-router';

import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';
import { codeBlockCommand } from '@src/terminal/code-block-command';

interface CodeBlockRunButtonProps {
  language: string;
  /** Read at click time — the block's text is only known once it rendered. */
  code: () => string;
  className?: string;
}

/**
 * Run a markdown code block in a terminal: the project's open shell tab when
 * there is one, a new shell tab otherwise.
 *
 * URL-first like every other open: the click only navigates, carrying the
 * command as the dock's `startCommand`, and the mounted terminal types it once
 * its PTY is at a prompt (see `START_COMMAND_PARAM`). Only plain shells are
 * reused — an agent's terminal is running a CLI, and a script typed into it
 * would land as a prompt, not a command.
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
  const { navigation, currentDock } = useDockNavigation();

  const run = useCallback(async () => {
    const command = codeBlockCommand(language, code());
    if (!command) return;
    const viewMode = currentDock?.viewMode ?? undefined;
    const projectId = dataContext.project?.id ?? null;
    const shells = (await tabManager.getTerminalTabsSnapshot('project', projectId)).filter(
      (tab) => tab.target_type === Shell.type && tab.target_id,
    );
    const onScreen = currentDock?.shellId;
    const target = shells.find((tab) => tab.target_id === onScreen) ?? shells[0];
    if (target?.target_id) {
      const shown = await navigation.openShell(target.target_id, { startCommand: command, viewMode });
      if (shown) return;
    }
    await navigation.openNewShell({ startCommand: command, viewMode });
  }, [language, code, currentDock, navigation]);

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
