/**
 * `/dock/llm-setup` — the ADDRESS of the LLM setup question, and its exit condition.
 *
 * **Why an address for a popup at all.** `flow llm set auto` opens the chooser in a browser
 * when the box can fund nothing, and a CLI can hand a person nothing but a URL. An overlay has
 * no address, so this route exists to BE that URL.
 *
 * **Two steps, in this order, never both at once.** First a small popup asks the one question
 * — "what should issue your LLM calls?" — with "Choose a source" on the left and "Skip for now"
 * on the right. Only "Choose a source" opens the keys dialog (`HarnessLoginModal`, "Assistants &
 * keys"); nothing opens on arrival. Skip, or a source arriving, carries on to whatever this was
 * opened over (the setup wizard's own popup, with its tools).
 *
 * **It carries on by itself.** The command that sent the user here is blocked on a socket, and it
 * returns the instant the box can fund a call. So this route watches the SAME resolver the CLI
 * blocks on, and leaves when it agrees. Closing the keys dialog with nothing chosen goes back to
 * the question — it is not treated as a Skip, because a source picked a moment ago closes the
 * dialog slightly before the funding status catches up.
 *
 * **Skip is an answer too.** A person who does not want to choose now says so here, which
 * releases the waiting command. Nothing is written — the box stays unfunded until someone picks
 * a source.
 */
import { Trans } from '@lingui/react/macro';
import { InstallState, llmSourcesService } from '@sdk';
import { Check, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { openHarnessLoginModal, useHarnessLoginStore } from '@src/components/harness-login/harness-login-store';
import { useLlmSources } from '@src/components/llm-sources/use-llm-sources';
import { harnessStatus, useStatusRecord } from '@src/components/status/use-status-record';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@src/components/ui/dialog';
import { getHistoryPosition } from '@src/navigation/history-position-store';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

export function LlmSetupView() {
  const open = useHarnessLoginStore((s) => s.open);
  const setOpen = useHarnessLoginStore((s) => s.setOpen);
  const { status } = useLlmSources();
  const { status: record } = useStatusRecord();

  /**
   * The source that funds the DEFAULT harness — the one a person is about to run.
   *
   * "Set up" means that harness is funded, not that some harness is: a funded codex does not
   * make a Claude-default box ready. Every resolved source is evidence (the resolver never
   * presumes a login), so there is no separate "verified" check. A default that is not installed
   * cannot be funded by anything, so then any funded harness answers — the same rule as
   * `flow llm set auto`; first-run setup asks again once it has installed the default.
   */
  const funded = useMemo(() => {
    const kind = record?.default_harness;
    const harness = kind ? harnessStatus(record, kind) : undefined;
    if (kind && harness?.install === InstallState.Installed) return status?.resolved?.[kind] ?? null;
    return Object.values(status?.resolved ?? {}).find(Boolean) ?? null;
  }, [status, record]);

  const { navigation, windowMode } = useDockNavigation();
  // `ask` is the small two-button popup; `keys` is the "Assistants & keys" dialog it opened.
  const [stage, setStage] = useState<'ask' | 'keys'>('ask');
  const [skipping, setSkipping] = useState(false);
  // This question is answered ONCE — a Skip, or a source arriving — however many times the effects
  // below re-run while the navigation it triggers settles.
  const answered = useRef(false);
  // Return to wherever the person was — same rule as an answered `ask` question:
  // there is somewhere to go back to only in the dock (`windowMode` never renders this).
  const leave = useCallback(() => {
    setOpen(false);
    if (getHistoryPosition().canGoBack) navigation.goBack();
    else navigation.goHome();
  }, [navigation, setOpen]);

  const skip = useCallback(async () => {
    if (answered.current) return;
    answered.current = true;
    setSkipping(true);
    try {
      await llmSourcesService.skip();
    } finally {
      setSkipping(false);
      leave();
    }
  }, [leave]);

  // Only this button opens the keys dialog — never arrival.
  const choose = useCallback(() => {
    setStage('keys');
    openHarnessLoginModal();
  }, []);

  // The box can fund a call (a login, a key or a FlowPad sign-in, from either seam): close the
  // dialog and carry on. In a browser window of its own there is nowhere to go back to, so that
  // one keeps the "You're set up" card below.
  useEffect(() => {
    if (!funded) return;
    setOpen(false);
    if (!windowMode && !answered.current) {
      answered.current = true;
      leave();
    }
  }, [funded, windowMode, leave, setOpen]);

  // The keys dialog was closed with nothing chosen: back to the question, where "Choose a source"
  // or "Skip for now" is still the person's call. Not an automatic Skip — a source picked a moment
  // ago closes the dialog slightly BEFORE the funding status catches up, and skipping then would
  // tell the waiting command "not now" for a question that was just answered.
  useEffect(() => {
    if (stage === 'keys' && !open && !funded) setStage('ask');
  }, [stage, open, funded]);

  if (funded) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <Check className="h-8 w-8 text-emerald-500" />
          <h1 className="text-lg font-semibold" data-testid="llm-setup-done">
            <Trans>You're set up</Trans>
          </h1>
          {windowMode ? (
            // A real browser window opened for this one question — script-closing a window
            // this app did not itself `window.open()` is unreliable, so this says what
            // actually works (⌘W / the window's own control) rather than a button that may
            // not do anything.
            <p className="text-sm text-muted-foreground">
              <Trans>{funded.name} is issuing your LLM calls. Close this window (⌘W) — you're done here.</Trans>
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      {/* Not while the keys dialog is up: one dialog at a time, in the order the question asks. */}
      <Dialog open={stage === 'ask'}>
        <DialogContent
          hideClose
          className="sm:max-w-sm"
          data-testid="llm-setup-popup"
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <Sparkles className="h-8 w-8 text-muted-foreground/60" />
            <DialogTitle className="text-lg font-semibold">
              <Trans>What should issue your LLM calls?</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>Pick FlowPad, an assistant you already pay for, or paste an API key.</Trans>
            </DialogDescription>
            <div className="mt-1 flex gap-2">
              <Button onClick={choose} data-testid="llm-setup-reopen">
                <Trans>Choose a source</Trans>
              </Button>
              <Button variant="ghost" disabled={skipping} onClick={() => void skip()} data-testid="llm-setup-skip">
                <Trans>Skip for now</Trans>
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default LlmSetupView;
