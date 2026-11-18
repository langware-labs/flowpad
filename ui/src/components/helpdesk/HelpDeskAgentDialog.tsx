/**
 * Setting up one of a desk's optional agents, from its Customer agent / Team agent row: what it does, then when it
 * replies on the desk, then Launch. The channel is the desk and the side comes from the row -- the person never
 * picks either. Launch makes the agent, gives it the desk (its source says the side and when it replies) and runs
 * it on this computer.
 */
import { createHelpDeskAgent, HelpDeskAgentSide, type HelpDeskAgent } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Dialog } from '@src/components/ui/dialog';
import { SteppedDialogContent } from '@src/components/ui/stepped-dialog';
import { Switch } from '@src/components/ui/switch';
import { Textarea } from '@src/components/ui/textarea';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

function Choice({ label, detail, control }: { label: ReactNode; detail: ReactNode; control: ReactNode }) {
  return (
    <label className="flex items-start gap-3 rounded-md border px-3 py-2.5 text-sm">
      <span className="pt-0.5">{control}</span>
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </span>
    </label>
  );
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
  const [step, setStep] = useState<'what' | 'when'>('what');
  const [instructions, setInstructions] = useState('');
  const [notPickedUp, setNotPickedUp] = useState(true);
  const [tagged, setTagged] = useState(true);
  const [moderated, setModerated] = useState(true);
  const [launching, setLaunching] = useState(false);
  const title = side === HelpDeskAgentSide.CUSTOMER ? t`Customer agent` : t`Team agent`;

  const launch = async () => {
    setLaunching(true);
    try {
      const made = await createHelpDeskAgent(
        {
          desk_project_id: deskId,
          side,
          instructions,
          reply_not_picked_up: notPickedUp,
          reply_tagged: tagged,
          moderated: side === HelpDeskAgentSide.CUSTOMER ? moderated : true,
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
    step === 'what'
      ? [{ label: title }, { label: t`What it does` }]
      : [{ label: title }, { label: t`What it does`, onClick: () => setStep('what') }, { label: t`When it replies` }];

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <SteppedDialogContent
        crumbs={crumbs}
        data-testid="help-desk-agent-dialog"
        footer={
          step === 'what' ? (
            <Button onClick={() => setStep('when')} data-testid="help-desk-agent-next">
              <Trans>Next</Trans>
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep('what')}>
                <Trans>← Back</Trans>
              </Button>
              <Button
                disabled={launching || (!notPickedUp && !tagged)}
                onClick={() => void launch()}
                data-testid="help-desk-agent-launch"
              >
                {launching && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                <Trans>Launch agent</Trans>
              </Button>
            </>
          )
        }
      >
        {step === 'what' ? (
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">
              <Trans>Channel: Help desk · {deskName}</Trans>
            </p>
            <p className="text-muted-foreground">
              {side === HelpDeskAgentSide.CUSTOMER ? (
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
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">
              <Trans>When should it reply on {deskName}?</Trans>
            </p>
            <p className="text-xs text-muted-foreground">
              <Trans>Reply when (pick any)</Trans>
            </p>
            <Choice
              label={<Trans>Conversation not picked up</Trans>}
              detail={<Trans>nobody on the team has taken the ticket</Trans>}
              control={<Checkbox checked={notPickedUp} onCheckedChange={(v) => setNotPickedUp(v === true)} />}
            />
            <Choice
              label={<Trans>Agent tagged</Trans>}
              detail={<Trans>someone writes @agent in the conversation</Trans>}
              control={<Checkbox checked={tagged} onCheckedChange={(v) => setTagged(v === true)} />}
            />
            {side === HelpDeskAgentSide.CUSTOMER && (
              <Choice
                label={<Trans>Moderated replies</Trans>}
                detail={<Trans>it writes a draft and does not send it; a team member sends</Trans>}
                control={<Switch checked={moderated} onCheckedChange={setModerated} />}
              />
            )}
          </div>
        )}
      </SteppedDialogContent>
    </Dialog>
  );
}
