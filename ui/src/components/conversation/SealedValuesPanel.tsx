import { useCallback, useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { credentialsService, dataContext, type SealedCard, type SealedSent } from '@sdk';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';

/**
 * Secured transfer in a conversation (flow_sdk/secrets/sealed_transfer.py): the receiver's card — "Eran sent you
 * values for Acme Gmail" with Fill in / Decline — and the sender's — waiting / filled in / declined. The sealed
 * messages live on the hub only; this re-reads them whenever the conversation changes (`version`). Names only:
 * a value is never fetched to the page.
 */
export function SealedValuesPanel({ conversationId, version }: { conversationId: string; version?: string | null }) {
  const { t } = useLingui();
  const [cards, setCards] = useState<SealedCard[]>([]);
  const [sent, setSent] = useState<SealedSent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!conversationId || !dataContext.caps.localFiles) return; // sealed values live in this machine's store
    const { incoming, sent: mine } = await credentialsService
      .sealedState(conversationId)
      .catch(() => ({ incoming: [] as SealedCard[], sent: [] as SealedSent[] }));
    setCards(incoming);
    setSent(mine);
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const act = async (card: SealedCard, what: 'fill' | 'decline' | 'get') => {
    setBusy(card.message_id);
    setError(null);
    try {
      if (what === 'fill') await credentialsService.sealedFill(conversationId, card.message_id);
      else if (what === 'decline') await credentialsService.sealedDecline(conversationId, card.message_id);
      else await credentialsService.sealedGet(conversationId, card.transfer_id);
      await load();
    } catch (e) {
      setError(errorMessage(e, t`The values could not be filled in.`));
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
            <p className="mt-1 text-xs text-green-600">
              <Trans>Filled in</Trans>
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
      {sent.map((row) => {
        const states = Object.values(row.recipients);
        const filled = states.filter((s) => s === 'filled').length;
        const waiting = states.filter((s) => s === 'pending').length;
        return (
          <div
            key={row.message_id}
            className={`max-w-xl rounded-lg border p-3 text-sm ${waiting ? 'border-primary/50' : 'border-green-500/50'} bg-muted/30`}
            data-testid="sealed-sent"
          >
            <div className="flex items-center gap-1.5 font-medium">
              <Lock className="h-3.5 w-3.5" />
              <Trans>Sealed values</Trans>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {row.expired ? (
                <Trans>Expired before everyone filled them in.</Trans>
              ) : waiting ? (
                <Trans>Waiting for {waiting} recipient(s) · only they can open them</Trans>
              ) : (
                <Trans>Filled in by {filled} · the sealed copy was deleted from the hub</Trans>
              )}
            </p>
          </div>
        );
      })}
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
