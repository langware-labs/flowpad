/**
 * The pieces a configured source is shown with — on its row in the list and on its own page alike, so the two can
 * never say different things: the status line, the actions (Verify, the setup stages, the menu with Pull), and the
 * setup details (what is unfinished, where its messages go, why it is parked).
 */
import { useCallback, useState } from 'react';
import { type DataSource, type DataDriver } from '@sdk';
import { CheckCircle2 } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { i18n } from '@lingui/core';
import { Button } from '@src/components/ui/button';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { WikiButton } from '@src/components/wiki-tip';
import { SetupStagesButton } from '@src/components/setup-wizard/SetupStagesButton';
import { healthStyle } from './health-style';
import { statusStyle } from './status-style';
import { PARKED_DOT, type SourceLook } from './source-look';
import { ChannelRouteControl } from './ChannelRouteControl';
import { SourceMenu } from './SourceMenu';
import { ATTENTION, type AttentionKind, attentionReason, attentionText } from './source-attention';
import { useSourceToggle } from './use-source-toggle';
import { useSourceVerify } from './use-source-verify';

/** The look of a source right now. The lifecycle answers first: health on a source that is not running describes
 *  the last time it ran — for one that never has, "never synced", i.e. nothing. */
export function sourceLook(source: DataSource): SourceLook {
  return source.isActive ? healthStyle(source.health) : statusStyle(source.status);
}

/** One coloured status line: the dot is the state at a glance, the words say it. A parked source — active, healthy-
 *  looking, and never polled again on its own — says so in its own words. */
export function SourceStatusLine({ source, className }: { source: DataSource; className?: string }) {
  const { t } = useLingui();
  const look = sourceLook(source);
  // One view of the line: parked, held (running, but a file waits on a person), or the source's own look.
  const view = source.isParked
    ? { text: 'text-foreground', dot: PARKED_DOT, label: t`Parked`, title: i18n._(ATTENTION.parked.next) }
    : source.isHeld
      ? { text: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500', label: t`Running · needs you`, title: source.error_detail || undefined }
      : { text: look.text, dot: look.dot, label: i18n._(look.label), title: undefined };
  return (
    <span
      className={cn('flex min-w-0 items-center gap-1.5 text-xs font-medium', view.text, className)}
      data-testid={`source-status-${source.id}`}
      title={view.title}
    >
      <span className={cn('size-2 shrink-0 rounded-full', view.dot)} />
      <span className="truncate">{view.label}</span>
    </span>
  );
}

/**
 * Pull changes now. Reports through `notify`, like every verb on these screens: an inline note would be a second
 * result channel, and which one you got would depend on which action you picked.
 */
export function useSourcePull(source: DataSource) {
  const { t } = useLingui();
  const [pulling, setPulling] = useState(false);
  const pull = useCallback(async () => {
    setPulling(true);
    try {
      // Not synchronous: the detail says "on the next tick", which is the expectation this toast exists to set.
      notify.success({ title: source.name || source.provider, message: (await source.pollNow()).detail });
    } catch (error) {
      notify.error({
        title: t`Could not pull ${source.name || source.provider}`,
        message: errorMessage(error, t`The source was not queued.`),
      });
    } finally {
      setPulling(false);
    }
  }, [source, t]);
  return { pull, pulling };
}

interface ActionsProps {
  source: DataSource;
  spec?: DataDriver | null;
  onEdit: (source: DataSource) => void;
  onReplay: (source: DataSource) => void;
  onDelete: (source: DataSource) => void;
}

/** Verify (whenever Verify is what recovers the source — `ATTENTION[kind].verb`: setup unfinished, parked,
 *  or never evaluated), the setup stages, and the menu — Pull and the rest live there. */
export function SourceActions({ source, spec, onEdit, onReplay, onDelete }: ActionsProps) {
  const { t } = useLingui();
  const { pull, pulling } = useSourcePull(source);
  const { verify, busy: verifying } = useSourceVerify(source);
  const { toggle: toggleEnabled } = useSourceToggle(source);
  const reason = attentionReason(source);
  return (
    <div className="flex items-center justify-end gap-1">
      {reason && ATTENTION[reason.kind].verb === 'verify' && (
        <Button
          size="sm"
          variant="secondary"
          className="h-7 gap-1.5"
          disabled={pulling || verifying}
          data-testid={`source-verify-${source.id}`}
          onClick={() => void verify()}
        >
          <CheckCircle2 className="size-3.5" />
          {t`Verify`}
        </Button>
      )}
      <SetupStagesButton source={source} spec={spec} />
      <SourceMenu
        source={source}
        spec={spec}
        onPull={() => void pull()}
        pulling={pulling}
        onToggleEnabled={() => void toggleEnabled()}
        onEdit={onEdit}
        onReplay={onReplay}
        onDelete={onDelete}
      />
    </div>
  );
}

// The kinds this screen spells out under the source: the ones a person has to act on and that the status
// line alone does not explain. Tinted with a coloured border; the words stay the foreground colour (red
// text on a dark theme does not read).
const NOTE: Partial<Record<AttentionKind, string>> = {
  unresolved: 'border-amber-500/60 bg-amber-500/10',
  held: 'border-amber-500/60 bg-amber-500/10',
  parked: 'border-red-500/60 bg-red-500/10',
};

/** What is unfinished (with its wiki page), where the source's messages go, and — in the same words and with
 *  the same next step as the stream inbox's attention strip (`ATTENTION`) — why a source is not delivering. */
export function SourceSetupDetails({ source, spec }: { source: DataSource; spec?: DataDriver | null }) {
  const { t } = useLingui();
  // The setup page comes from the source's own manifest, so a new source brings its own help.
  const wiki = spec?.setup_wiki || undefined;
  const reason = attentionReason(source);
  const note = reason && NOTE[reason.kind];
  return (
    <>
      {reason?.kind === 'setup' && (
        <div className="flex items-start gap-1.5 rounded bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
          <p className="flex-1">{attentionText(reason)}</p>
          {/* A wiki page, not a tooltip: "invite the bot" is a multi-step task performed in ANOTHER application,
              and a hover card cannot be read while doing it. */}
          {wiki && <WikiButton wikiword={wiki} label={t`How to finish setup`} />}
        </div>
      )}

      <ChannelRouteControl source={source} />

      {reason && note && (
        <p
          className={cn('rounded border px-2 py-1.5 text-[11px] leading-snug', note)}
          data-testid={`source-${reason.kind}-${source.id}`}
        >
          <span className="block break-words">{attentionText(reason)}</span>
          <span className="block text-muted-foreground">{i18n._(ATTENTION[reason.kind].next)}</span>
        </p>
      )}
    </>
  );
}
