import { useCallback, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { chromeEntityActionClassName, chromeGlyphClassName } from '@src/components/entity-actions/action-button-styles';
import { WorkerIcon } from '@src/components/entity-execution-panel/history-row';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { useDefaultWorkerType } from '@src/contexts/HarnessCapabilitiesContext';
import { useLastWorkerType, workerToOpener } from '@src/components/terminal/openers/useLastWorkerType';
import { WORKER_LABELS } from '@src/hooks/useWorkerHistory';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { openNewChat } from '@src/navigation/open-new-chat';
import { openCapabilitiesForWorker } from '@src/navigation/open-capabilities';

/**
 * Quick launch: one glyph in the navigation bar that starts a fresh agentic
 * session in a single click, with nothing to pick first.
 *
 * The two things a chat launcher normally asks for are both already decided:
 *   - the HARNESS is the last one launched from any surface (the shared
 *     last-opener preference the terminal strip and `WorkerToolbar` write),
 *     falling back to the capability-selected default before a first launch;
 *   - the MODE is the current View mode — `openNewChat` reads it and settles
 *     transport, surface and persona from that one value, so this button gets
 *     vibe / chat / terminal right without restating any of those rules.
 *
 * The launch is routed through `openNewChat` for exactly that reason: it is THE
 * front-face open-a-chat chain (chats side-menu, `+` tab, quick-create), so a
 * session born here is identical to one born there.
 */
export function NewChatButton() {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { lastWorker, rememberWorker } = useLastWorkerType();
  const defaultWorker = useDefaultWorkerType();
  const [starting, setStarting] = useState(false);

  const worker = lastWorker ?? defaultWorker;
  const label = WORKER_LABELS[workerToOpener(worker)];

  const start = useCallback(() => {
    // Guarded here rather than through `disabled` so a click while a launch is
    // in flight is dropped without the button going dead to the pointer (and so
    // it still leaves a trace if a launch promise never settles).
    if (starting) return;
    setStarting(true);
    // Remembered up front, matching `WorkerToolbar.launch`: the pick is the
    // user's even if the spawn then fails for a missing binary.
    rememberWorker(worker);
    void openNewChat(navigation, { workerType: worker })
      .catch((err) => {
        console.error('[NewChatButton] new chat failed', err);
        // A failed create is almost always the harness missing from this
        // machine; Capabilities re-probes the kind it arrives with.
        openCapabilitiesForWorker(navigation, worker);
      })
      .finally(() => setStarting(false));
  }, [starting, rememberWorker, worker, navigation]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={`shrink-0 ${chromeEntityActionClassName}`}
          onClick={start}
          aria-label={t`New ${label} chat`}
          data-testid="top-nav-new-chat"
          data-worker={worker}
        >
          {/* The vendor's OWN mark, through the shared `WorkerIcon` — so the
              glyph says which harness this click will start, and a fifth vendor
              is a `PROVIDER_META` row rather than an edit here. The tint comes
              from that table; the size has to be passed, because the packs
              render a brand mark as a mask `span`, not an `svg`, and the chrome
              contract sizes `svg` descendants only. `Loader2` IS an svg, so it
              is sized by the button and says nothing about size here. */}
          {starting ? (
            <Loader2 className="animate-spin" />
          ) : (
            <WorkerIcon workerType={worker} className={`${chromeGlyphClassName} shrink-0`} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {t`New ${label} chat`}
      </TooltipContent>
    </Tooltip>
  );
}
