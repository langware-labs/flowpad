/**
 * The "what is wrong, what to do" strip a channel mark opens above the inbox list.
 *
 * Clicking a mark on the channels line filters the list to that channel. When that
 * channel is not listening — a setup step is owed, it is parked on a configuration
 * error, or it is paused — the filtered list is empty or stale, and a tooltip is not
 * where a person learns why. This strip sits between the filter row and the list and
 * says, per source: the reason, the next step, and the verb that takes it — Verify or
 * Resume, the source's settings, its setup wizard, its help page.
 *
 * Verify's answer is shown IN the strip, not toasted: the person is looking here.
 * The strip unmounts by itself once the entity updates to a listening state, because
 * the mount filters on `attentionReason`, the one classifier every channel surface reads.
 *
 * Nothing here knows a provider. The reason is the source's own words, the next step
 * is by kind, and any provider-specific help comes from the driver's manifest
 * (`setup_wiki`, `setup_wizards`).
 */
import type { ReactNode } from 'react';
import { type DataDriver, type DataSource } from '@sdk';
import { CheckCircle2, Play, Settings2 } from 'lucide-react';
import { i18n } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';
import { Button } from '@src/components/ui/button';
import { WikiButton } from '@src/components/wiki-tip';
import { SetupStagesButton } from '@src/components/setup-wizard/SetupStagesButton';
import { openSource } from '@src/components/data-sources/data-sources-pointer';
import {
  ATTENTION_FALLBACK,
  ATTENTION_NEXT_STEP,
  type AttentionKind,
  type AttentionReason,
  attentionReason,
} from '@src/components/data-sources/source-attention';
import { sourceGlyphs } from '@src/components/data-sources/source-icon';
import { useSourceToggle } from '@src/components/data-sources/use-source-toggle';
import { useSourceVerify } from '@src/components/data-sources/use-source-verify';
import { IconWithBadge } from '@src/components/graph-view/icons/IconWithBadge';
import { channelKeyOf } from './channel-owner';

export interface AttentionItem {
  source: DataSource;
  reason: AttentionReason;
}

/** The sources among `rows` whose channel the list is narrowed to and that are not listening. */
export function attentionAmong(rows: DataSource[], selected: ReadonlySet<string>): AttentionItem[] {
  if (selected.size === 0) return [];
  const items: AttentionItem[] = [];
  for (const source of rows) {
    const reason = selected.has(channelKeyOf(source)) ? attentionReason(source) : null;
    if (reason) items.push({ source, reason });
  }
  return items;
}

const TINT: Record<AttentionKind, string> = {
  // Tinted row, coloured border, foreground words: red (or amber) text on a dark theme does not read.
  setup: 'border-amber-500/40 bg-amber-500/10',
  parked: 'border-red-500/60 bg-red-500/10',
  paused: 'border-border bg-muted/40',
};

export function ChannelAttentionBar({
  items,
  specFor,
  className,
}: {
  items: AttentionItem[];
  specFor: (provider: string) => DataDriver | undefined;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className={cn('shrink-0', className)} role="status" data-testid="channel-attention-bar">
      {items.map(({ source, reason }) => (
        <AttentionRow key={source.id} source={source} reason={reason} spec={specFor(source.provider)} />
      ))}
    </div>
  );
}

function AttentionRow({ source, reason, spec }: { source: DataSource; reason: AttentionReason; spec: DataDriver | undefined }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { verify, busy: verifying, last } = useSourceVerify(source, { quiet: true });
  const { toggle, busy: toggling } = useSourceToggle(source);
  const { Base, Badge } = sourceGlyphs(spec, source.channel);
  const name = source.name || source.provider;
  const paused = reason.kind === 'paused';

  // What is wrong, and what to do. After a Verify press, its answer replaces both until the
  // entity itself moves on (a ready answer unmounts the row as soon as the row updates).
  let wrong = reason.text || i18n._(ATTENTION_FALLBACK[reason.kind]);
  let next: ReactNode = i18n._(ATTENTION_NEXT_STEP[reason.kind]);
  const failed = last?.error ?? (last?.result?.transient ? last.result.detail : undefined);
  if (failed !== undefined) {
    wrong = t`Could not check — ${failed}`;
    next = <Trans>Try again in a moment.</Trans>;
  } else if (last?.result?.ready) {
    wrong = t`Now listening.`;
    next = <Trans>New messages will appear here on the next poll.</Trans>;
  } else if (last?.result) {
    wrong = last.result.detail;
    next = last.result.pending?.length ? (
      <ul className="list-disc ps-4">
        {last.result.pending.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ul>
    ) : (
      <Trans>Finish that, then press Verify again.</Trans>
    );
  }

  // The one verb for this kind: Resume un-pauses; Verify re-runs the check and un-parks.
  const action = paused
    ? { Icon: Play, label: t`Resume`, run: toggle, busy: toggling, testId: 'channel-attention-resume' }
    : { Icon: CheckCircle2, label: t`Verify`, run: verify, busy: verifying, testId: 'channel-attention-verify' };

  return (
    <div
      className={cn('flex items-start gap-3 border-b border-s-4 px-3 py-2 text-xs text-foreground', TINT[reason.kind])}
      data-testid={`channel-attention-${source.id}`}
      data-kind={reason.kind}
    >
      <IconWithBadge Base={Base} Badge={Badge} className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="truncate font-medium">
          {name}
          {source.account_key ? <span className="text-muted-foreground"> · {source.account_key}</span> : null}
        </div>
        <div className="break-words" data-testid="channel-attention-wrong">
          {wrong}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground" data-testid="channel-attention-next">
          <span>{next}</span>
          {spec?.setup_wiki && reason.kind === 'setup' && (
            <WikiButton wikiword={spec.setup_wiki} label={t`How to finish setup`} />
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="secondary"
          className="h-7 gap-1.5"
          disabled={action.busy}
          onClick={() => void action.run()}
          data-testid={action.testId}
        >
          <action.Icon className="size-3.5" />
          {action.label}
        </Button>
        <SetupStagesButton source={source} spec={spec} />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5"
          onClick={() => openSource(navigation, source.id, 'settings')}
          aria-label={t`Open settings of ${name}`}
          data-testid="channel-attention-settings"
        >
          <Settings2 className="size-3.5" />
          {t`Settings`}
        </Button>
      </div>
    </div>
  );
}
