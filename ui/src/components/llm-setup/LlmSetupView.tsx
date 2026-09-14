/**
 * `/dock/llm-setup` — the ADDRESS of the LLM setup popup, and its exit condition.
 *
 * **Why an address for a popup at all.** `flow llm set auto` opens the chooser in a browser
 * when the box can fund nothing, and a CLI can hand a person nothing but a URL. An overlay has
 * no address, so this route exists to BE that URL: it opens the one popup, watches for the
 * question to be answered, and gets out of the way. Everything the user sees is
 * `HarnessLoginModal` — there is no second chooser and no second look.
 *
 * **It closes itself.** The command that sent the user here is blocked on a socket, and it
 * returns the instant the box can fund a call. If the popup stayed open the user would be left
 * staring at a form for a question that has already been answered, with a finished command
 * behind it in a terminal they cannot see. So this route watches the SAME resolver the CLI
 * blocks on and dismisses the popup when it agrees — the two halves of one moment.
 *
 * The card behind it is not decoration: it says what the box landed on, so the browser half
 * shows the same answer the terminal half just printed.
 */
import { Trans } from '@lingui/react/macro';
import { Check, Sparkles } from 'lucide-react';
import { useEffect, useMemo } from 'react';

import { openHarnessLoginModal, useHarnessLoginStore } from '@src/components/harness-login/harness-login-store';
import {
  useFundingFollowsHubLogin,
  useFundingFollowsLogin,
  useLlmSources,
} from '@src/components/llm-sources/use-llm-sources';
import { Button } from '@src/components/ui/button';

export function LlmSetupView() {
  const open = useHarnessLoginStore((s) => s.open);
  const setOpen = useHarnessLoginStore((s) => s.setOpen);
  const { status } = useLlmSources();
  // Both seams, because a source can arrive either way: a device login or a stored key comes
  // through `capabilityManager`, a FlowPad endpoint through the hub login. Watching one only
  // would leave the popup open over exactly half the ways of answering it.
  useFundingFollowsLogin();
  useFundingFollowsHubLogin();

  /**
   * The source that would fund a call.
   *
   * `unverified` is the BACKEND's verdict (`Candidate.unverified`), read here rather than
   * re-derived — the CLI reads the same field, so the popup and the command that opened it
   * cannot disagree about whether you are set up. This was previously a second copy of the
   * rule living in this file, which is exactly the drift the published flag removes.
   */
  const funded = useMemo(() => {
    for (const pick of Object.values(status?.resolved ?? {})) {
      if (!pick || pick.unverified) continue;
      return pick;
    }
    return null;
  }, [status]);

  // Open on arrival, and only on arrival — re-opening whenever `open` went false would make
  // the popup impossible to close while on this route.
  useEffect(() => {
    openHarnessLoginModal();
  }, []);

  // ...and dismiss it the moment the box can fund a call.
  useEffect(() => {
    if (funded) setOpen(false);
  }, [funded, setOpen]);

  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        {funded ? (
          <>
            <Check className="h-8 w-8 text-emerald-500" />
            <h1 className="text-lg font-semibold" data-testid="llm-setup-done">
              <Trans>You're set up</Trans>
            </h1>
            <p className="text-sm text-muted-foreground">
              <Trans>{funded.name} is issuing your LLM calls. You can close this tab.</Trans>
            </p>
          </>
        ) : (
          <>
            <Sparkles className="h-8 w-8 text-muted-foreground/60" />
            <h1 className="text-lg font-semibold">
              <Trans>What should issue your LLM calls?</Trans>
            </h1>
            <p className="text-sm text-muted-foreground">
              <Trans>Pick FlowPad, an assistant you already pay for, or paste an API key.</Trans>
            </p>
            {!open && (
              <Button className="mt-1" onClick={() => openHarnessLoginModal()} data-testid="llm-setup-reopen">
                <Trans>Choose a source</Trans>
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default LlmSetupView;
