import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Info } from 'lucide-react';
import { AGENT_CHANNELS, type AgentChannel, type AgentMode } from '@sdk';
import { Label } from '@src/components/ui/label';
import { SegmentedControl } from '@src/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Switch } from '@src/components/ui/switch';
import gmailMark from '../../../../../../flow_sdk/server/icons/brands/assets/gmail.svg';
import slackMark from '../../../../../../flow_sdk/server/icons/brands/assets/slack.svg';

/** The idle windows offered; 15 minutes is the default. */
export const IDLE_CHOICES = [300, 900, 1800, 3600] as const;
export const DEFAULT_IDLE_SECONDS = 900;

export interface AgentModeValue {
  mode: AgentMode;
  channels: AgentChannel[];
  idleSeconds: number;
}

export const DEFAULT_AGENT_MODE: AgentModeValue = {
  mode: 'private',
  channels: [...AGENT_CHANNELS],
  idleSeconds: DEFAULT_IDLE_SECONDS,
};

function ChannelMark({ channel }: { channel: AgentChannel }) {
  if (channel === 'email') return <img src={gmailMark} alt="" className="size-4" />;
  if (channel === 'slack') return <img src={slackMark} alt="" className="size-4" />;
  return (
    <span className="flex size-4 items-center justify-center rounded-sm bg-orange-500 font-mono text-[9px] font-bold text-black">
      {'{}'}
    </span>
  );
}

function channelLabel(channel: AgentChannel): string {
  return channel === 'email' ? t`Email` : channel === 'slack' ? t`Slack` : t`Chat API`;
}

/**
 * How a deployed agent meets people: Shared (one machine answers everyone) or Private (each person gets their own
 * machine on their first message), the channels it answers on besides Flowpad messages, and how long a machine
 * waits idle before it pauses. One label column, the dialog's own controls.
 */
export function AgentModeFields({
  value,
  onChange,
  disabled,
}: {
  value: AgentModeValue;
  onChange: (next: AgentModeValue) => void;
  disabled?: boolean;
}) {
  const toggle = (channel: AgentChannel, on: boolean) =>
    onChange({
      ...value,
      channels: on ? [...new Set([...value.channels, channel])] : value.channels.filter((c) => c !== channel),
    });
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-3" data-testid="new-deployment-agent-mode">
      <Label className="text-xs text-muted-foreground">
        <Trans>Agent mode</Trans>
      </Label>
      <div className="flex items-center gap-2">
        <SegmentedControl<AgentMode>
          options={[
            ['shared', t`Shared`],
            ['private', t`Private`],
          ]}
          value={value.mode}
          onChange={(mode) => onChange({ ...value, mode })}
          testId="new-deployment-mode"
          disabled={disabled}
          ariaLabel={t`Agent mode`}
        />
        <span
          title={t`Private: each person who talks to it gets their own machine, started on their first message. Shared: everyone reaches one machine.`}
          className="cursor-help text-muted-foreground"
        >
          <Info className="size-3.5" />
        </span>
      </div>

      <Label className="self-start pt-2 text-xs text-muted-foreground">
        <Trans>Channels</Trans>
      </Label>
      <div className="flex flex-col gap-1">
        <div className="flex gap-2">
          {AGENT_CHANNELS.map((channel) => (
            <label
              key={channel}
              className="flex h-9 flex-1 items-center gap-2 whitespace-nowrap rounded-md border px-2.5 text-xs"
              title={channel === 'chat_api' ? t`OpenAI-style chat endpoint, called with the person's API key` : undefined}
            >
              <ChannelMark channel={channel} />
              <span className="flex-1">{channelLabel(channel)}</span>
              <Switch
                checked={value.channels.includes(channel)}
                onCheckedChange={(on) => toggle(channel, on)}
                disabled={disabled}
                aria-label={channelLabel(channel)}
                data-testid={`new-deployment-channel-${channel}`}
              />
            </label>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground">
          <Trans>Flowpad messages always reach it.</Trans>
        </span>
      </div>

      <Label htmlFor="new-deployment-idle" className="text-xs text-muted-foreground">
        <Trans>Auto-pause</Trans>
      </Label>
      <Select
        value={String(value.idleSeconds)}
        disabled={disabled}
        onValueChange={(next) => onChange({ ...value, idleSeconds: Number(next) })}
      >
        <SelectTrigger id="new-deployment-idle" className="h-8 w-44 text-xs" data-testid="new-deployment-idle">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {IDLE_CHOICES.map((seconds) => (
            <SelectItem key={seconds} value={String(seconds)} className="text-xs">
              {t`After ${seconds / 60} min idle`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
