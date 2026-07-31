import { Agent } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Button } from '@src/components/ui/button';
import { Textarea } from '@src/components/ui/textarea';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

interface AgentRunDialogProps {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRunningChange?: (running: boolean) => void;
}

/**
 * Ask for a prompt, run the agent, then navigate to the process that records
 * the run.
 *
 * `Agent.run()` is a command that acknowledges — it hands back the process id,
 * which is what makes navigating possible and what makes a failure visible.
 * The backend routes the run to the compute node the agent's deployment places
 * it on; a deployment we cannot reach fails loudly here rather than silently
 * executing on the server, so the error is worth surfacing verbatim.
 */
export function AgentRunDialog({ agent, open, onOpenChange, onRunningChange }: AgentRunDialogProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (open) setPrompt('');
  }, [open]);

  useEffect(() => onRunningChange?.(running), [running, onRunningChange]);

  const run = async () => {
    const text = prompt.trim();
    if (!text || running) return;
    setRunning(true);
    try {
      const result = await agent.run(text);
      onOpenChange(false);
      notify.success({ title: t`Agent started`, message: agent.name ?? '' });
      // openShellProcess is the real navigate-to-a-spawned-process path
      // (openEntity is still a stub that only logs). Same call the vibe
      // session uses after createVibeProcessForProject.
      if (result?.process_id) await navigation.openShellProcess(result.process_id);
    } catch (e) {
      notify.error({
        title: t`Could not run agent`,
        message: e instanceof Error ? e.message : t`Run failed.`,
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Run {agent.name}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>What should it do? Its system prompt is already applied.</Trans>
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t`Describe the task…`}
          aria-label={t`Prompt`}
          className="min-h-28"
          autoFocus
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={running}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void run()} disabled={!prompt.trim() || running}>
            {running ? <Trans>Starting…</Trans> : <Trans>Run</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
