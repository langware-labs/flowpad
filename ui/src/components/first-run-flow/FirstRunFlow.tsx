import { useEffect, useRef } from 'react';
import { Trans } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useFirstRunGate } from '@src/components/project-setup/first-run-gate';
import { openSetupWizard } from '@src/components/setup-incomplete/open-setup-wizard';
import { useSetupIncompleteWarning } from '@src/components/setup-incomplete/use-setup-incomplete-warning';
import { useWizardPopupStore } from '@src/components/assets/editor/wizard/wizard-popup-store';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useFirstRunFlowStore } from './first-run-flow-store';

/**
 * The first-run flow, mounted once at the app root (`App.tsx`): its three windows, and what leads from each to
 * the next. The wizard popup itself is window 1 (`WizardPopupRoot`); this opens it and watches it close.
 *
 *   app load, a project setup, an invitation -> [wizard ran fully?] no -> window 1 (the wizard)
 *   window 1: Skip or X -> window 2 (Run setup -> window 1 | Continue anyway or X -> window 3) -> X
 *   the end: the first-run gate is open. A load lands on the home page; a project setup and an invitation
 *   go on by themselves, because they were waiting for the gate.
 */
export function FirstRunFlowRoot() {
  const gate = useFirstRunGate();
  const { step, origin, minimized, setMinimized, setStep, start, end, appLoadChecked, markAppLoadChecked } =
    useFirstRunFlowStore();
  const popupOpen = useWizardPopupStore((state) => state.open);
  const { navigation, currentDock } = useDockNavigation();

  const finish = (goHome = true) => {
    const from = origin;
    end();
    // A load lands on the home page; a project setup and an invitation go on by themselves, waiting on the gate.
    // Not by navigating when the tab is ALREADY there (the app root, `currentDock.isRoot`): that re-ran the home
    // page's loader and the page flashed as if it had been opened again.
    if (goHome && from === 'app_load' && currentDock && !currentDock.isRoot) navigation.goHome({ homePage: true });
  };

  // 1. Every app load: the wizard opens when it has not run fully on this computer. 'loading' waits; anything the
  // gate cannot tell is OPEN (`useFirstRunGate`), so a failed lookup never holds the app.
  useEffect(() => {
    if (appLoadChecked || gate.state === 'loading') return;
    markAppLoadChecked();
    if (gate.state === 'closed') start('app_load');
  }, [gate.state, appLoadChecked, start, markAppLoadChecked]);

  // 2. Window 1: open the wizard (blank -- the person presses its own Start), and see it close.
  const opened = useRef(false);
  useEffect(() => {
    if (step !== 'wizard') {
      opened.current = false;
      return;
    }
    if (opened.current) return;
    opened.current = true;
    openSetupWizard()
      .then((shown) => {
        // No wizard to show here: nothing to wait for.
        if (!shown) end();
      })
      // A failed open must not leave the flow in 'wizard' with no window, hiding every other dialog.
      .catch(() => end());
  }, [step, end]);
  const seenOpen = useRef(false);
  useEffect(() => {
    if (step !== 'wizard') {
      seenOpen.current = false;
      return;
    }
    if (popupOpen) {
      seenOpen.current = true;
      setMinimized(false);
      return;
    }
    if (!seenOpen.current) return;
    seenOpen.current = false;
    // Minimized, not closed: the run goes on in the background and the flow waits for how it ends (below).
    if (useFirstRunFlowStore.getState().minimized) return;
    // Closed by Skip or X -- or by finishing. A wizard that ran fully has opened the gate: the flow is over.
    if (gate.state === 'open') finish();
    else setStep('skip-notice');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popupOpen, step]);

  // 3. Minimized while the installs run: the run decides. All OK opens the gate and ends the flow; one that
  // ended short goes on to window 2, as if the person had closed the wizard then.
  const incomplete = useSetupIncompleteWarning();
  useEffect(() => {
    if (step !== 'wizard' || !minimized) return;
    // Minutes may have passed and the person is elsewhere by now: ending quietly, never taking them somewhere.
    if (gate.state === 'open') finish(false);
    else if (incomplete) setStep('skip-notice');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, minimized, gate.state, incomplete]);

  const runSetup = () => setStep('wizard');
  const continueAnyway = async () => {
    // Window 3 is the last. A load waits on nothing, so leaving it opens nothing: the next project setup or
    // invitation meets the wizard again, as the spec has it ("before every project setup"). A project setup or an
    // invitation DOES wait on the gate, so its way out opens it for this session; if that fails the window stays,
    // because ending the flow with a closed gate would leave whoever waits on it waiting.
    if (origin === 'app_load' || (await gate.continueAnyway())) finish();
  };

  return (
    <>
      <Dialog open={step === 'skip-notice'} onOpenChange={(open) => !open && setStep('how-to')}>
        <DialogContent data-testid="first-run-skip-notice" onInteractOutside={(event) => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>
              <Trans>Flowpad was not installed with all the required dependencies</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Some tools Flowpad relies on are missing, so parts of it may not work. Run the setup to install them.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" data-testid="first-run-continue-anyway" onClick={() => setStep('how-to')}>
              <Trans>Continue anyway</Trans>
            </Button>
            <Button data-testid="first-run-run-setup" onClick={runSetup}>
              <Trans>Run setup</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={step === 'how-to'} onOpenChange={(open) => !open && void continueAnyway()}>
        <DialogContent data-testid="first-run-how-to" onInteractOutside={(event) => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>
              <Trans>You can run the setup later</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                To install the missing tools at any time, go to{' '}
                <strong>Settings → General → Run setup again</strong>.
              </Trans>
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}
