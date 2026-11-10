import { useState } from 'react';
import { Lock } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { credentialsService, type SealedCard } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useProjects } from '@src/hooks/use-projects';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { describeApiError, errorMessage } from '@src/lib/error-message';

const PERSONAL = 'personal';

/**
 * A key someone typed into Secured transfer (no credential behind it): "Eran sent you OPENAI_API_KEY", a Save to
 * select (this conversation's project first, Personal last) and one Accept click. A name that already has a value
 * there asks Replace / Keep mine.
 */
export function SealedTypedCard({
  card,
  conversationId,
  projectId,
  onDone,
  onDecline,
}: {
  card: SealedCard;
  conversationId: string;
  /** The conversation's project — the default place. */
  projectId?: string | null;
  onDone: () => Promise<void> | void;
  onDecline: () => void;
}) {
  const { t } = useLingui();
  const { projects } = useProjects();
  const { navigation } = useDockNavigation();
  const [place, setPlace] = useState<string>(projectId || PERSONAL);
  const [busy, setBusy] = useState(false);
  const [clash, setClash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = card.credential_name || '';

  const save = async (replace: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await credentialsService.sealedFill(conversationId, card.message_id, { place, replace });
      await onDone();
    } catch (e) {
      if (describeApiError(e).code === 'exists') setClash(true);
      else setError(errorMessage(e, t`The key could not be saved.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="max-w-xl rounded-lg border border-primary/50 bg-muted/30 p-3 text-sm"
      data-testid="sealed-card"
      data-state={clash ? 'exists' : card.state}
    >
      <div className="flex items-center gap-1.5 font-medium">
        <Lock className="h-3.5 w-3.5" />
        {name ? (
          <Trans>
            {card.sender_name || t`A member`} sent you <span className="font-mono">{name}</span>
          </Trans>
        ) : (
          // Once answered the envelope is not opened again, so the name is no longer known here.
          <Trans>{card.sender_name || t`A member`} sent you a key</Trans>
        )}
      </div>
      {card.state === 'filled' ? (
        <div className="mt-1 flex items-center gap-2 text-xs text-green-600">
          <Trans>Saved to your credentials</Trans>
          <button
            type="button"
            className="text-primary underline-offset-2 hover:underline"
            onClick={() => navigation.openDock(DockPointer.forCredentials(undefined, place === PERSONAL ? undefined : place))}
            data-testid="sealed-open"
          >
            <Trans>Open</Trans>
          </button>
        </div>
      ) : card.state === 'declined' ? (
        <p className="mt-1 text-xs text-muted-foreground">
          <Trans>Declined</Trans>
        </p>
      ) : card.state !== 'pending' ? (
        <p className="mt-1 text-xs text-amber-600" title={card.error}>
          <Trans>This key can't be opened here — ask {card.sender_name || t`the sender`} to send it again.</Trans>
        </p>
      ) : clash ? (
        <>
          <p className="mt-1 text-xs text-amber-600" data-testid="sealed-clash">
            <Trans>You already have {name} here. Replace it with this one?</Trans>
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void save(true)} data-testid="sealed-replace">
              <Trans>Replace</Trans>
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={onDecline} data-testid="sealed-keep">
              <Trans>Keep mine</Trans>
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Trans>Save to</Trans>
            <select
              className="h-7 rounded-md border border-input bg-background px-1.5 text-xs text-foreground"
              value={place}
              onChange={(e) => setPlace(e.target.value)}
              data-testid="sealed-place"
            >
              {(projects ?? []).map((p) => (
                <option key={String(p.id)} value={String(p.id)}>
                  {p.title || p.name}
                </option>
              ))}
              <option value={PERSONAL}>{t`Personal (every project)`}</option>
            </select>
          </label>
          <Button size="sm" disabled={busy} onClick={() => void save(false)} data-testid="sealed-accept">
            <Trans>Accept</Trans>
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={onDecline} data-testid="sealed-decline">
            <Trans>Decline</Trans>
          </Button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
