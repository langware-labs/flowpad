import { useLingui } from '@lingui/react/macro';
import { CornerDownRight } from 'lucide-react';
import { SteerStatus, type SteerMeta } from '@sdk';

/**
 * The internal agent's steer into the support agent's ticket process, as the team conversation shows it: what was
 * sent and how the delivery ended. The status is all that ever comes back; the support agent's words never do.
 */
export function SteerLine({ steer, senderName, text }: { steer: SteerMeta; senderName: string; text: string }) {
  const { t } = useLingui();
  const who = senderName || t`The internal agent`;
  const status = {
    [SteerStatus.SENDING]: t`Sending`,
    [SteerStatus.RAN]: t`Delivered, the agent ran it`,
    [SteerStatus.FAILED]: t`Not delivered`,
    [SteerStatus.BUSY]: t`The agent was busy`,
    [SteerStatus.CAPPED]: t`Not run: the turn limit for this ticket was reached`,
  }[steer.status];
  return (
    <div
      className="my-1 flex flex-col gap-0.5 px-2 text-xs text-muted-foreground"
      data-testid="steer-line"
      data-status={steer.status}
    >
      <span className="flex items-center gap-1.5">
        <CornerDownRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t`${who} steered the support agent`}</span>
      </span>
      {text && <p className="whitespace-pre-wrap pl-5 text-sm text-foreground">{text}</p>}
      <span className="pl-5 italic" data-testid="steer-status">
        {status}
      </span>
    </div>
  );
}
