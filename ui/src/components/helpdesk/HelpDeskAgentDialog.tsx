/**
 * Setting up one of a desk's optional agents, from its Support agent / Team agent row: what it does (with a few ideas
 * to start from), then whether its answers wait for the team, then Launch. The channel is the desk and the side comes
 * from the row -- the person never picks either. Launch makes the agent, gives it the desk (its source says the side
 * and that it replies to untaken and tagged tickets) and runs it: the support agent in the cloud, on its own
 * deployment; the team agent on this computer.
 */
import { createHelpDeskAgent, HelpDeskAgentSide, type HelpDeskAgent } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@src/components/ui/button';
import { Dialog } from '@src/components/ui/dialog';
import { SteppedDialogContent } from '@src/components/ui/stepped-dialog';
import { Textarea } from '@src/components/ui/textarea';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

/** The dialog's two steps. */
enum SetupStep {
  WHAT = 'what',
  LAUNCH = 'launch',
}

export function HelpDeskAgentDialog({
  deskId,
  deskName,
  side,
  onOpenChange,
  onLaunched,
}: {
  deskId: string;
  deskName: string;
  side: HelpDeskAgentSide;
  onOpenChange: (open: boolean) => void;
  onLaunched: (agent: HelpDeskAgent) => void;
}) {
  const { t } = useLingui();
  const [step, setStep] = useState<SetupStep>(SetupStep.WHAT);
  const [instructions, setInstructions] = useState('');
  const [launching, setLaunching] = useState(false);
  const customer = side === HelpDeskAgentSide.CUSTOMER;
  const title = customer ? t`Support agent (customer facing)` : t`Team agent (internal)`;
  const ideas = customer
    ? [
        t`Thank the customer at once, then follow the ticket.`,
        t`Ask the customer for what the team needs.`,
        t`Close the ticket when the customer confirms.`,
        t`Answer in the customer's language.`,
      ]
    : [
        t`Run /rca on every request.`,
        t`Ask the support agent when you need more from the customer.`,
        t`Post the RCA report for the team.`,
        t`Answer when a teammate tags @agent.`,
      ];

  const launch = async () => {
    setLaunching(true);
    try {
      const made = await createHelpDeskAgent(
        {
          desk_project_id: deskId,
          side,
          instructions,
        },
        deskName,
      );
      onLaunched(made);
      onOpenChange(false);
    } catch (e: unknown) {
      notify.error({ title: t`Could not launch the agent`, message: errorMessage(e, ''), forceToast: true });
    } finally {
      setLaunching(false);
    }
  };

  const crumbs =
    step === SetupStep.WHAT
      ? [{ label: title }, { label: t`What it does` }]
      : [{ label: title }, { label: t`What it does`, onClick: () => setStep(SetupStep.WHAT) }, { label: t`Launch` }];

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <SteppedDialogContent
        crumbs={crumbs}
        data-testid="help-desk-agent-dialog"
        footer={
          step === SetupStep.WHAT ? (
            <Button onClick={() => setStep(SetupStep.LAUNCH)} data-testid="help-desk-agent-next">
              <Trans>Next</Trans>
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep(SetupStep.WHAT)}>
                <Trans>← Back</Trans>
              </Button>
              <Button disabled={launching} onClick={() => void launch()} data-testid="help-desk-agent-launch">
                {launching && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                <Trans>Launch agent</Trans>
              </Button>
            </>
          )
        }
      >
        {step === SetupStep.WHAT ? (
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">
              <Trans>Channel: Help desk · {deskName}</Trans>
            </p>
            <p className="text-muted-foreground">
              {customer ? (
                <Trans>On the customer side: makes sure the team has everything it needs from the customer.</Trans>
              ) : (
                <Trans>On the team side: writes a first root-cause analysis for a team member to review.</Trans>
              )}
            </p>
            <Textarea
              rows={8}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={t`Instructions, in your words. Leave empty for the default for this side.`}
              data-testid="help-desk-agent-instructions"
            />
            <div className="flex flex-wrap items-center gap-2" data-testid="help-desk-agent-ideas">
              <span className="text-xs text-muted-foreground">
                <Trans>Try:</Trans>
              </span>
              {ideas.map((idea) => (
                <Button key={idea} size="sm" variant="secondary" onClick={() => setInstructions(idea)}>
                  {idea}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {customer ? (
                <Trans>
                  It answers customers while nobody on the team has picked the ticket up. It runs in the cloud, not on
                  this computer.
                </Trans>
              ) : (
                <Trans>It writes to the team only, never to the customer. It runs on this computer.</Trans>
              )}
            </p>
          </div>
        )}
      </SteppedDialogContent>
    </Dialog>
  );
}
