import { type ReactNode, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { type InboundApi, InboundWebhooks, type InboundNumber, type InboundReach } from '@sdk';
import { Loader2 } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { claimTitle } from './inbound-model';
import { errorText } from './use-inbound';

interface Checked {
  id: string;
  name: string;
  reach: InboundReach | null;
  error: string | null;
  misroutes: number;
}

/**
 * Check route: each claim of a number (its rules, then the fallback) probed hop by hop with `probe {phase: reach}`.
 * Nothing is sent to a channel. A target that is offline means the hub answers the vendor 503 (it retries; nothing
 * is lost); misroutes mean the place answered 404 — the channel is not there any more.
 */
export function RouteCheck({
  open,
  onOpenChange,
  number,
  onChangeDestination,
  api = InboundWebhooks,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  number: InboundNumber;
  onChangeDestination?: (claimId: string) => void;
  api?: InboundApi;
}) {
  const { t } = useLingui();
  const [rows, setRows] = useState<Checked[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setRows(null);
    const claims = [
      ...number.rules.map((r, i) => ({ claim: r, name: t`Rule ${i + 1} · ${claimTitle(r)}` })),
      { claim: number.claim, name: t`Fallback — everything else` },
    ];
    void Promise.all(
      claims.map(async ({ claim, name }) => {
        try {
          return { id: claim.id, name, reach: await api.probe(claim.id), error: null, misroutes: claim.misroutes };
        } catch (e) {
          return { id: claim.id, name, reach: null, error: errorText(e), misroutes: claim.misroutes };
        }
      }),
    ).then((checked) => alive && setRows(checked));
    return () => {
      alive = false;
    };
  }, [open, number, api, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[85vh] max-w-lg overflow-y-auto"
        data-testid="inbound-route-check"
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Check route</Trans> · {claimTitle(number.claim)}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          <Trans>Each hop, without sending a message.</Trans>
        </p>
        {!rows && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
        {rows?.map((row) => (
          <div
            key={row.id}
            className="divide-y rounded-xl border border-border bg-card text-sm"
            data-testid={`inbound-route-${row.id}`}
            data-ok={row.reach?.ok ? 'true' : 'false'}
          >
            <div className="flex items-center justify-between px-4 py-2 font-medium">
              <span>{row.name}</span>
              <Pill ok={!!row.reach?.ok}>{row.reach?.ok ? t`ok` : t`not reachable`}</Pill>
            </div>
            {row.error && <div className="px-4 py-2 text-destructive">{row.error}</div>}
            {row.reach?.hops.map((hop) => (
              <div key={hop.hop} className="flex items-center justify-between gap-3 px-4 py-2">
                <span className="min-w-0">
                  <span className="font-mono text-xs text-muted-foreground">{hop.hop}</span>{' '}
                  <span className="break-all">{hop.detail}</span>
                </span>
                <Pill ok={hop.ok}>{hop.ok ? t`ok` : offline(hop) ? t`offline` : t`failed`}</Pill>
              </div>
            ))}
            {row.reach?.hops.some((h) => !h.ok && offline(h)) && (
              <div className="px-4 py-2 text-muted-foreground" data-testid={`inbound-route-offline-${row.id}`}>
                <Trans>
                  While it is offline, the hub answers 503 and your server retries — nothing is lost and nothing is
                  stored. Messages from other senders keep flowing.
                </Trans>
              </div>
            )}
            {row.misroutes > 0 && (
              <div
                className="flex items-center justify-between gap-3 px-4 py-2 text-muted-foreground"
                data-testid={`inbound-route-misroute-${row.id}`}
              >
                <span>
                  <Trans>
                    Misroutes ×{row.misroutes}: the place answered 404 — that channel is not there any more. Pick
                    another destination.
                  </Trans>
                </span>
                {onChangeDestination && (
                  <Button size="sm" variant="outline" onClick={() => onChangeDestination(row.id)}>
                    <Trans>Change destination</Trans>
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>
            <Trans>Close</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A hop that failed because its place is not connected right now (a desktop away, a relay down). */
function offline(hop: { hop: string; ok: boolean; detail: string }): boolean {
  return hop.hop === 'target' && /not connected|unreachable/.test(hop.detail);
}

function Pill({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span
      className={
        ok
          ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-500'
          : 'rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-500'
      }
    >
      {children}
    </span>
  );
}
