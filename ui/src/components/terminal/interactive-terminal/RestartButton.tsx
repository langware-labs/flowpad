/**
 * RestartButton — the always-visible Restart control of the terminal surface,
 * at the left of the top bar beside the debug menu.
 *
 * Restart awareness is backend-driven: any worker-relevant change flips
 * `process.restart_required`, and the button glows so the signal is visible
 * without opening a menu. It is the same restart the session actions menu
 * offers on the other surfaces.
 */

import { AgenticProcess } from '@sdk';
import { isProcessRunning } from '@sdk/process/agentic-types.js';
import { CompactIconAction } from '@src/components/entity-actions/CompactIconAction';
import { Loader2, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';

export function RestartButton({ process }: { process: AgenticProcess }) {
  const { t } = useLingui();
  const [isRestarting, setIsRestarting] = useState(false);
  const started = isProcessRunning(process.status);
  const restartRequired = !!process.restart_required && started;

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
    <CompactIconAction
      icon={isRestarting ? Loader2 : RotateCcw}
      iconClassName={isRestarting ? 'animate-spin' : undefined}
      testId="process-toolbar-restart-button"
      label={
        isRestarting
          ? t`Restarting…`
          : !started
            ? t`Session is not running`
            : restartRequired
              ? t`Restart required — config changed since start`
              : t`Restart session`
      }
      disabled={isRestarting || !started}
      attention={restartRequired}
      onClick={() => void handleRestart()}
    />
  );
}
