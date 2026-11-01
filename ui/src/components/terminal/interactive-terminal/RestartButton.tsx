/**
 * RestartButton — the always-visible Restart control of the terminal surface,
 * at the left of the top bar beside the debug menu.
 *
 * Restart awareness is backend-driven: any worker-relevant change flips
 * `process.restart_required`, and the button glows. Hovering the glowing button
 * shows what changed (RestartChangesList), with a link to Command Status.
 */

import { AgenticProcess } from '@sdk';
import { isProcessRunning } from '@sdk/process/agentic-types.js';
import { CompactIconAction } from '@src/components/entity-actions/CompactIconAction';
import { Loader2, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useRestartRequiredHint } from './useRestartRequiredHint';
import { RestartChangesList } from './RestartChangesList';
import { CommandStatusViewer } from './command-status-viewer';

export function RestartButton({ process }: { process: AgenticProcess }) {
  const { t } = useLingui();
  const [isRestarting, setIsRestarting] = useState(false);
  const [showCommandStatus, setShowCommandStatus] = useState(false);
  const started = isProcessRunning(process.status);
  const restartHint = useRestartRequiredHint(process);
  const showChanges = !!restartHint && !isRestarting;

  const handleRestart = async () => {
    if (isRestarting) return;
    setIsRestarting(true);
    try {
      await process.restart();
    } finally {
      setIsRestarting(false);
    }
  };

  return (
    <>
      <CompactIconAction
        icon={isRestarting ? Loader2 : RotateCcw}
        iconClassName={isRestarting ? 'animate-spin' : undefined}
        testId="process-toolbar-restart-button"
        label={
          isRestarting ? t`Restarting…` : !started ? t`Session is not running` : (restartHint ?? t`Restart session`)
        }
        disabled={isRestarting || !started}
        attention={!!restartHint}
        onClick={() => void handleRestart()}
        hoverContent={
          showChanges ? (
            <RestartChangesList process={process} onShowAll={() => setShowCommandStatus(true)} />
          ) : undefined
        }
      />
      {showCommandStatus && <CommandStatusViewer open onClose={() => setShowCommandStatus(false)} process={process} />}
    </>
  );
}
