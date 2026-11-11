import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Lock, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { credentialsService, dataContext, type EntityMember, type SealedCard, type SealedSent } from '@sdk';
import { useOnTag } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { useTestVerdict } from '@src/components/credentials/credential-test-verdict';
import { errorMessage } from '@src/lib/error-message';

/**
 * Secured transfer in a conversation (flow_sdk/secrets/sealed_transfer.py): the receiver's card — "Eran sent you
 * values for Acme Gmail" with Fill in / Decline — and the sender's — waiting / filled in / declined. The sealed
 * messages live on the hub only; this re-reads them whenever the conversation changes (`version`) and on every
 * push of the conversation — a receiver's answer (a hub-only ack) arrives as an UNCHANGED conversation update
 * (sealed_transfer.on_sealed_arrival), so its updated_date alone would never move. Names only: a value is never
 * fetched to the page.
 */
export function SealedValuesPanel({
  conversationId,
  version,
  members = [],
}: {
  conversationId: string;
  version?: string | null;
  /** The conversation's roster — a receiver's name by hub user id. */
  members?: readonly EntityMember[];
}) {
  const { t } = useLingui();
  const [cards, setCards] = useState<SealedCard[]>([]);
  const [sent, setSent] = useState<SealedSent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const verdict = useTestVerdict();
  const names = useMemo(
    () => Object.fromEntries(members.filter((m) => m.user_id).map((m) => [String(m.user_id), m.name || m.email || ''])),
    [members],
  );

  // One read at a time: a push that lands while a read is in flight (a receiver's `validated` ~0.3 s after its
  // `filled`) is read once more after it — an identical GET in flight is joined, not re-sent, and its answer predates
  // the push. Answers are applied in order, so an older one never lands last.
  const reading = useRef<{ id: string; done: Promise<void>; again: boolean } | null>(null);
  const shown = useRef(conversationId);
  shown.current = conversationId;
  const load = useCallback(async () => {
    if (!conversationId || !dataContext.caps.localFiles) return; // sealed values live in this machine's store
    if (reading.current?.id === conversationId) {
      reading.current.again = true;
      return reading.current.done;
    }
    const read = { id: conversationId, done: Promise.resolve(), again: false };
    const run = async () => {
      do {
        read.again = false;
        const { incoming, sent: mine } = await credentialsService
          .sealedState(conversationId)
          .catch(() => ({ incoming: [] as SealedCard[], sent: [] as SealedSent[] }));
        if (shown.current !== conversationId) return; // the panel moved to another conversation meanwhile
        setCards(incoming);
        setSent(mine);
      } while (read.again);
    };
    read.done = run().finally(() => {
      if (reading.current === read) reading.current = null;
    });
    reading.current = read;
    return read.done;
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load, version]);
  useOnTag('app.entity.updated', () => void load(), { target: `conversation:${conversationId}` });

  const act = async (card: SealedCard, what: 'fill' | 'decline' | 'get') => {
    setBusy(card.message_id);
    setError(null);
    try {
      if (what === 'fill') await credentialsService.sealedFill(conversationId, card.message_id);
      else if (what === 'decline') await credentialsService.sealedDecline(conversationId, card.message_id);
      else await credentialsService.sealedGet(conversationId, card.transfer_id);
      await load();
    } catch (e) {
      setError(errorMessage(e, what === 'get' ? t`The values could not be requested.` : t`The values could not be filled in.`));
    } finally {
      setBusy(null);
    }
  };

  if (!cards.length && !sent.length) return null;
  return (
    <div className="mx-4 my-2 flex flex-col gap-2" data-testid="sealed-values-panel">
      {cards.map((card) => (
        <div
          key={card.message_id}
          className="max-w-xl rounded-lg border border-primary/50 bg-muted/30 p-3 text-sm"
          data-testid="sealed-card"
          data-state={card.state}
        >
          <div className="flex items-center gap-1.5 font-medium">
            <Lock className="h-3.5 w-3.5" />
            <Trans>
              {card.sender_name || t`A member`} sent you values for {card.credential_title || card.credential_name || t`a credential`}
            </Trans>
          </div>
          {card.variables?.length ? (
            <div className="mt-1 font-mono text-xs text-muted-foreground">{card.variables.join(', ')}</div>
          ) : null}
          {card.state === 'get' ? (
            <>
              <p className="mt-1 text-xs text-muted-foreground">
                <Trans>They were sent before this Flowpad could receive them — get them now, it takes a moment.</Trans>
              </p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" disabled={busy === card.message_id} onClick={() => void act(card, 'get')} data-testid="sealed-get">
                  <Trans>Get the secret</Trans>
                </Button>
              </div>
            </>
          ) : card.state === 'requested' ? (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="sealed-requested">
              <Trans>Getting the values from {card.sender_name || t`the sender`}'s Flowpad… they arrive by themselves.</Trans>
            </p>
          ) : card.state === 'pending' ? (
            <>
              <p className="mt-1 text-xs text-muted-foreground">
                <Trans>The values go straight into your credential — they are not shown here.</Trans>
              </p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" disabled={busy === card.message_id} onClick={() => void act(card, 'fill')} data-testid="sealed-fill">
                  <Trans>Fill in</Trans>
                </Button>
                <Button size="sm" variant="outline" disabled={busy === card.message_id} onClick={() => void act(card, 'decline')} data-testid="sealed-decline">
                  <Trans>Decline</Trans>
                </Button>
              </div>
            </>
          ) : card.state === 'filled' ? (
            <p className={`mt-1 text-xs ${card.test ? verdict(card.test, 'self').tone : 'text-green-600'}`}>
              {card.test ? verdict(card.test, 'self').text : <Trans>Filled in</Trans>}
            </p>
          ) : card.state === 'declined' ? (
            <p className="mt-1 text-xs text-muted-foreground">
              <Trans>Declined</Trans>
            </p>
          ) : card.state === 'expired' ? (
            <p className="mt-1 text-xs text-amber-600">
              <Trans>Expired — ask {card.sender_name || t`the sender`} to share again.</Trans>
            </p>
          ) : (
            <p className="mt-1 text-xs text-amber-600" title={card.error}>
              <Trans>These values can't be opened here — ask {card.sender_name || t`the sender`} to share again.</Trans>
            </p>
          )}
        </div>
      ))}
      {sent.map((row) => (
        <SentRow key={row.message_id} row={row} names={names} />
      ))}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}


/** The quiet, automatic line of a secured-transfer key exchange ("Bob shared public key for secured transfer"). */
export function SealedNoteLine({ text }: { text: string }) {
  return (
    <div data-testid="sealed-note-line" className="flex items-center justify-center gap-1.5 py-0.5 text-[11px] text-muted-foreground/80">
      <Lock className="h-3 w-3" />
      <span>{text}</span>
      <span className="rounded bg-muted px-1 text-[10px]">
        <Trans>automatic</Trans>
      </span>
    </div>
  );
}


/**
 * The sender's view of one share whose values travelled: per receiver, Sent → Delivered (the values landed on
 * their machine) → Validated (the credential's own test passed THERE, run by their Flowpad right after).
 */
function SentRow({ row, names }: { row: SealedSent; names: Record<string, string> }) {
  const { t } = useLingui();
  const users = Object.keys(row.recipients);
  const allGood = users.length > 0 && users.every((u) => row.tests?.[u]?.state === 'ok');
  return (
    <div
      className={`max-w-xl rounded-lg border p-3 text-sm ${allGood ? 'border-green-500/50' : 'border-primary/50'} bg-muted/30`}
      data-testid="sealed-sent"
    >
      <div className="flex items-center gap-1.5 font-medium">
        <Lock className="h-3.5 w-3.5" />
        {row.route === 'vault' ? <Trans>Shared values · secret manager</Trans> : <Trans>Shared values · secured transfer</Trans>}
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {users.map((uid) => (
          <ReceiverLine
            key={uid}
            name={names[uid] || t`A member`}
            stage={row.recipients[uid]}
            test={row.tests?.[uid]}
            expired={row.expired}
            vault={row.route === 'vault'}
          />
        ))}
      </ul>
    </div>
  );
}

function ReceiverLine({
  name,
  stage,
  test,
  expired,
  vault,
}: {
  name: string;
  stage: SealedSent['recipients'][string];
  test?: NonNullable<SealedSent['tests']>[string];
  expired: boolean;
  vault: boolean;
}) {
  const { t } = useLingui();
  const verdict = useTestVerdict();
  const at = test?.at ? new Date(test.at).toLocaleString() : '';
  const result: { icon: LucideIcon | null; tone: string; text: string } =
    stage === 'declined'
      ? { icon: X, tone: 'text-muted-foreground', text: t`Declined` }
      : stage === 'pending'
        ? expired
          ? { icon: TriangleAlert, tone: 'text-amber-600', text: t`Expired before it was opened` }
          : { icon: null, tone: 'text-muted-foreground', text: vault ? t`Not fetched yet` : t`Not opened yet` }
        : test
          ? verdict(test.state, 'sender')
          : { icon: null, tone: 'text-muted-foreground', text: t`Not reported` };
  const Icon = result.icon;
  return (
    <li className="flex flex-wrap items-center gap-x-1.5 text-xs" data-testid="sealed-receiver" data-stage={stage} data-test={test?.state ?? ''}>
      <span className="font-medium text-foreground">{name}</span>
      <span className="text-muted-foreground">·</span>
      <Step done label={t`Sent`} />
      <Step done={stage === 'filled'} label={t`Delivered`} />
      <span className={`inline-flex items-center gap-0.5 ${result.tone}`} title={at}>
        {Icon && <Icon className="h-3 w-3" />}
        {result.text}
      </span>
    </li>
  );
}

function Step({ done, label }: { done: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-0.5 ${done ? 'text-green-600' : 'text-muted-foreground/60'}`}>
      {done && <Check className="h-3 w-3" />}
      {label}
      <span className="text-muted-foreground">·</span>
    </span>
  );
}
