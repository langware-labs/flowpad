import { useCallback, useState } from 'react';
import { AgenticProcess, type FSRef } from '@sdk';
import { Button } from '@src/components/ui/button';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { Loader2 } from 'lucide-react';

type WorkerType = 'claude_code' | 'codex';

interface Harness {
  workerType: WorkerType;
  name: string;
  Icon: typeof ClaudeIcon;
  iconClassName?: string;
}

const HARNESSES: Harness[] = [
  { workerType: 'claude_code', name: 'claude', Icon: ClaudeIcon, iconClassName: 'text-orange-500' },
  { workerType: 'codex', name: 'codex', Icon: CodexIcon },
];

interface Props {
  /** FSRef of the doc the user is currently editing. */
  fsRef: FSRef;
}

/**
 * Header-toolbar buttons that spawn a new harness tab pre-seeded with a
 * "discuss this doc" prompt. One square icon per harness — same shape as
 * `TerminalOpenerToolbar`'s inline buttons.
 */
export function DiscussDocButtons({ fsRef }: Props) {
  const [pending, setPending] = useState<WorkerType | null>(null);

  const handleClick = useCallback(
    async (workerType: WorkerType) => {
      if (pending) return;
      setPending(workerType);
      try {
        // FSRef.path is the VFS sub-path (no leading slash). Normalize for
        // the human-facing prompt so claude sees an absolute path.
        const absPath = fsRef.path.startsWith('/') ? fsRef.path : `/${fsRef.path}`;
        const prompt = `Lets discuss ${absPath}, Do not take any actions yet`;
        await AgenticProcess.openTab(workerType, prompt);
      } catch (err) {
        console.error('[DiscussDocButtons] openTab failed', err);
      } finally {
        setPending(null);
      }
    },
    [fsRef.path, pending],
  );

  return (
    <>
      {HARNESSES.map(({ workerType, name, Icon, iconClassName }) => {
        const isPending = pending === workerType;
        const disabled = pending !== null;
        return (
          <Button
            key={workerType}
            variant="secondary"
            size="icon"
            className="h-7 w-7 rounded"
            onClick={() => void handleClick(workerType)}
            disabled={disabled}
            aria-label={`Discuss this doc with ${name}`}
            title={`Discuss this doc with ${name}`}
            data-testid={`discuss-doc-button-${name}`}
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Icon className={`h-4 w-4 ${iconClassName ?? ''}`} />
            )}
          </Button>
        );
      })}
    </>
  );
}
