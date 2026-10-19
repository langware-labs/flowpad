import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ChannelRouteTarget } from '@sdk';
import { Input } from '@src/components/ui/input';
import { cn } from '@src/lib/utils';
import { type DestinationOption, manualTarget, samePlace } from './inbound-model';

/**
 * Where a claim's messages go: one of the listed places, or a place typed by hand (a desktop instance or a
 * machine, and the channel id there). Only existing channels are listed — nothing is created on a box.
 */
export function DestinationPicker({
  options,
  value,
  onChange,
}: {
  options: DestinationOption[];
  value: ChannelRouteTarget | null;
  onChange: (target: ChannelRouteTarget | null) => void;
}) {
  const { t } = useLingui();
  const listed = value ? options.find((o) => samePlace(o.target, value)) : undefined;
  const [manual, setManual] = useState(!!value && !listed && value.kind !== 'none');
  const [kind, setKind] = useState<'desktop' | 'node'>(value?.kind === 'node' ? 'node' : 'desktop');
  const [where, setWhere] = useState(value?.kind === 'node' ? (value.node_typeid ?? '') : (value?.instance_id ?? ''));
  const [channel, setChannel] = useState(value?.data_source_id ?? '');

  const typed = (k: 'desktop' | 'node', w: string, c: string) => onChange(manualTarget(k, w, c));

  return (
    <div className="flex flex-col gap-2" data-testid="inbound-destinations">
      {options.map((o) => (
        <Choice
          key={o.key}
          testId={o.testId}
          selected={!manual && !!value && samePlace(o.target, value)}
          title={o.label}
          detail={o.detail}
          onClick={() => {
            setManual(false);
            onChange(o.target);
          }}
        />
      ))}
      <Choice
        testId="inbound-dest-manual"
        selected={manual}
        title={t`A place and channel by hand…`}
        detail={t`A desktop instance or a machine, and a channel id on it`}
        onClick={() => {
          setManual(true);
          typed(kind, where, channel);
        }}
      />
      {manual && (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
          <div className="flex gap-2">
            {(['desktop', 'node'] as const).map((k) => (
              <button
                key={k}
                type="button"
                data-testid={`inbound-manual-kind-${k}`}
                onClick={() => {
                  setKind(k);
                  typed(k, where, channel);
                }}
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-medium',
                  kind === k ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}
              >
                {k === 'desktop' ? <Trans>Desktop instance</Trans> : <Trans>Machine</Trans>}
              </button>
            ))}
          </div>
          <Input
            data-testid="inbound-field-manual-where"
            placeholder={kind === 'desktop' ? t`Instance id` : t`compute_node-…`}
            value={where}
            onChange={(e) => {
              setWhere(e.target.value);
              typed(kind, e.target.value, channel);
            }}
          />
          <Input
            data-testid="inbound-field-manual-channel"
            placeholder={t`Channel id (data source id there)`}
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value);
              typed(kind, where, e.target.value);
            }}
          />
        </div>
      )}
    </div>
  );
}

function Choice({
  title,
  detail,
  selected,
  onClick,
  testId,
}: {
  title: string;
  detail: string;
  selected: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'flex flex-col items-start gap-0.5 rounded-xl border bg-card px-4 py-3 text-start text-sm hover:bg-accent',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border',
      )}
    >
      <span className="font-semibold">{title}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </button>
  );
}
