import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { type ChannelRouteTarget, type InboundApi, type InboundClaim, InboundWebhooks, ruleChainBody } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { cn } from '@src/lib/utils';
import { DestinationPicker } from './DestinationPicker';
import { type DestinationOption, claimTitle } from './inbound-model';
import { errorText } from './use-inbound';

/**
 * Add a rule under a number (one sender or one group → one place), or — given `rule` — change where an existing
 * rule goes. The rule takes effect on the next message; the vendor is not touched.
 */
export function AddRuleDialog({
  open,
  onOpenChange,
  number,
  rule,
  options,
  onDone,
  api = InboundWebhooks,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  number: InboundClaim;
  /** Editing this rule's destination instead of adding one. */
  rule?: InboundClaim | null;
  options: DestinationOption[];
  onDone: () => void;
  api?: InboundApi;
}) {
  const { t } = useLingui();
  const [kind, setKind] = useState<'user' | 'group'>('user');
  const [key, setKey] = useState('');
  const [target, setTarget] = useState<ChannelRouteTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind(rule?.claim?.kind === 'group' ? 'group' : 'user');
    setKey(rule?.claim?.key ?? '');
    setTarget(rule ? rule.target : null);
    setError(null);
  }, [open, rule]);

  const ready = !!target && (!!rule || !!key.trim());

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      if (rule) await api.setTarget(rule.id, target);
      else await api.chain(ruleChainBody(number.id, kind, key, target));
      onDone();
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const chip = (active: boolean) =>
    cn(
      'rounded-full px-2 py-0.5 text-xs font-medium',
      active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[85vh] max-w-lg overflow-y-auto"
        data-testid="inbound-rule-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {claimTitle(number)}
            {rule && rule.id !== number.id && <> › {claimTitle(rule)}</>} ›{' '}
            {rule ? <Trans>Change destination</Trans> : <Trans>Add rule</Trans>}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          {!rule && (
            <>
              <div>
                <div className="mb-2 font-medium">
                  <Trans>Match</Trans>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="inbound-rule-kind-user"
                    className={chip(kind === 'user')}
                    onClick={() => setKind('user')}
                  >
                    <Trans>One sender</Trans>
                  </button>
                  <button
                    type="button"
                    data-testid="inbound-rule-kind-group"
                    className={chip(kind === 'group')}
                    onClick={() => setKind('group')}
                  >
                    <Trans>One group</Trans>
                  </button>
                  <button
                    type="button"
                    data-testid="inbound-rule-kind-keyword"
                    disabled
                    className={cn(chip(false), 'cursor-not-allowed opacity-60')}
                  >
                    <Trans>keyword / time — not supported</Trans>
                  </button>
                </div>
              </div>
              <label className="flex flex-col gap-1">
                <span className="font-medium">{kind === 'user' ? <Trans>Sender</Trans> : <Trans>Group</Trans>}</span>
                <Input
                  data-testid="inbound-field-rule-key"
                  value={key}
                  placeholder={kind === 'user' ? t`+972 54-123 4567` : t`120363…@g.us`}
                  onChange={(e) => setKey(e.target.value)}
                />
                <span className="text-xs text-muted-foreground">
                  {kind === 'user' ? (
                    <Trans>
                      The sender's number as the vendor sends it. Already claimed by someone else → refused.
                    </Trans>
                  ) : (
                    <Trans>The group's id as the vendor sends it. Already claimed by someone else → refused.</Trans>
                  )}
                </span>
              </label>
            </>
          )}
          <div className="font-medium">
            <Trans>Goes to</Trans>
          </div>
          <DestinationPicker options={options} value={target} onChange={setTarget} />
          {error && (
            <p className="text-sm text-destructive" data-testid="inbound-rule-error">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button data-testid="inbound-rule-save" disabled={!ready || busy} onClick={() => void submit()}>
            {rule ? <Trans>Save</Trans> : <Trans>Add rule</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
