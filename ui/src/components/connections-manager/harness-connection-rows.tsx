import { i18n } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import { LLMFundingKind } from '@sdk';
import { cn } from '@src/lib/utils';
import { WORKER_LABELS } from '@src/hooks/useWorkerHistory';
import { providerMetaFor } from '@src/tabs/provider-meta';
import {
  harnessKinds,
  sourcesOfKind,
  useLlmSources,
  workerOf,
} from '@src/components/llm-sources/use-llm-sources';
import { sourceVisual } from '@src/components/llm-sources/llm-source-visuals';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { TableCell, TableRow } from '../ui/table';

/** Display names are keyed by worker; `workerOf` hands back a plain string. */
const LABELS: Record<string, string> = WORKER_LABELS;

/**
 * The harness device logins — Claude, Codex, Copilot, OpenCode — as Connections rows.
 *
 * They are the credentials the assistants actually run on, and they were the one
 * kind of connection this table did not show. Its own producer rather than a
 * synthetic `allConnections` entry: that map is keyed by registered OAuth provider
 * name and gated on `grantStatuses`, and a harness login is in neither.
 *
 * **Read-only on purpose.** Signing in is a vendor CLI flow the login modal already
 * owns end to end — the device code, Claude's paste-back, the provider picker, the
 * probe. So the row reports and Details hands off. That also sidesteps an asymmetry
 * the row would otherwise have to explain: there is no logout for a harness at any
 * tier, because signing out means running the vendor's own CLI in your own terminal.
 */
export function HarnessConnectionRows({ onDetails }: { onDetails?: (worker: string) => void }) {
  const { t } = useLingui();
  const { status } = useLlmSources();

  // `null` is the hub: device logins are box facts, so `status()` answers null there
  // rather than an empty picture.
  if (!status) return null;

  return (
    <>
      {harnessKinds(status).map((kind) => {
        const worker = workerOf(kind);
        // The DEVICE candidate, not `resolved[kind]`: this row is about the harness's
        // own login, which must still be listed on a box where a stored API key
        // currently outranks it.
        const device = sourcesOfKind(status, kind, LLMFundingKind.Device)[0];
        const { Icon, iconClassName } = providerMetaFor(worker);
        const verdict = sourceVisual(device);

        return (
          <TableRow key={`harness:${kind}`} data-testid={`connection-row-harness-${worker}`}>
            <TableCell className="font-medium">
              <div className="flex items-center gap-2">
                <Icon className={cn('h-4 w-4 shrink-0', iconClassName)} />
                <span>{LABELS[worker] ?? worker}</span>
              </div>
            </TableCell>

            <TableCell>
              {/* NOT "Device code": that label belongs to the RFC 8628 OAuth device
                  grant, which exactly one registered provider uses. This is the
                  vendor CLI's own OAuth session — same words, different mechanism. */}
              <Badge
                variant="outline"
                className="text-xs font-normal"
                title={t`The assistant's own CLI sign-in, kept by the vendor on this machine`}
                data-testid={`connection-kind-harness-${worker}`}
              >
                <Trans>CLI login</Trans>
              </Badge>
            </TableCell>

            {/* Access requested and Used by are both empty: a harness login is
                machine-level, asks for no per-project scopes, and attaches to no
                project. */}
            <TableCell className="text-sm text-muted-foreground">—</TableCell>

            <TableCell>
              <div className="flex items-center gap-2 text-sm">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', verdict.dot)} />
                {/* One short word in the cell — a wrapping label is what made the two
                    halves of this table read as two different tables. The backend owns
                    the sentence and it is rendered verbatim, in the title. */}
                <span
                  className="whitespace-nowrap"
                  title={device?.reason || device?.detail || undefined}
                  data-testid={`connection-status-harness-${worker}`}
                >
                  {i18n._(verdict.text)}
                </span>
              </div>
            </TableCell>

            <TableCell className="text-sm text-muted-foreground">—</TableCell>

            <TableCell className="text-end">
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => onDetails?.(worker)}
                data-testid={`connection-harness-details-${worker}`}
              >
                <Trans>Details</Trans>
              </Button>
            </TableCell>
          </TableRow>
        );
      })}
    </>
  );
}
