import { i18n } from '@lingui/core';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { LLMFundingKind, type LLMSource } from '@sdk';
import { cn } from '@src/lib/utils';
import { WORKER_LABELS, type WorkerType } from '@src/hooks/useWorkerHistory';
import { providerMetaFor } from '@src/tabs/provider-meta';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import {
  harnessKinds,
  useLlmSources,
  workerOf,
} from '@src/components/llm-sources/use-llm-sources';
import { openLlmSources } from '@src/components/llm-sources/llm-sources-pointer';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { TableCell, TableRow } from '../ui/table';

/**
 * The harness device logins — Claude, Codex, Copilot, OpenCode — as Connections rows.
 *
 * They are the credentials the assistants actually run on, and they were the one
 * kind of connection this table did not show. A fourth row producer, beside
 * `FlowpadConnectionRow`: both are machine-scoped accounts, neither is an OAuth
 * grant, and neither can be a synthetic `allConnections` entry (that map is keyed
 * by registered OAuth provider name and gated on `grantStatuses`).
 *
 * **Read-only on purpose.** Signing in is a vendor CLI flow the login modal already
 * owns end to end — the device code, Claude's paste-back, the provider picker, the
 * probe. So the row reports and **Details** navigates to the screen that owns the
 * rest. That also sidesteps an asymmetry the row would otherwise have to explain:
 * there is no logout for a harness at any tier, because signing out means running
 * the vendor's own CLI in your own terminal.
 */
export function HarnessConnectionRows() {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { status } = useLlmSources();

  // `null` is the hub: device logins are box facts, so `status()` answers null there
  // rather than an empty picture. It is also the guard against offering a Details
  // link to a desk-only screen.
  if (!status) return null;

  return (
    <>
      {harnessKinds(status).map((kind) => {
        const worker = workerOf(kind);
        // The DEVICE candidate, not `resolved[kind]`: this row is about the harness's
        // own login, which must still be listed on a box where a stored API key
        // currently outranks it.
        const device = status.sources[kind]?.find(
          (s) => status.endpoints?.[s.endpoint_typeid]?.kind === LLMFundingKind.Device,
        );
        const { Icon, iconClassName } = providerMetaFor(worker);
        const verdict = verdictVisual(device);

        return (
          <TableRow key={`harness:${kind}`} data-testid={`connection-row-harness-${worker}`}>
            <TableCell className="font-medium">
              <div className="flex items-center gap-2">
                <Icon className={cn('h-4 w-4 shrink-0', iconClassName)} />
                <span>{WORKER_LABELS[worker as WorkerType] ?? worker}</span>
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

            {/* Machine-level: it asks for no per-project scopes and attaches to no
                project, so both columns are honestly empty. */}
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
                onClick={() => openLlmSources(navigation, worker)}
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

/**
 * What we can honestly say, from the verdict the backend already produces.
 *
 * "Not checked" is a first-class state rather than a hedge: `Capability.login_state`
 * does not survive a restart, so "nobody has asked" is the COMMON case, and only
 * Codex has a probe that verifies with the vendor at all.
 *
 * `msg` descriptors resolved at render, not `t` passed into a helper: `t` is a
 * build-time macro and only expands where it is written, so handing it to a
 * function silently produces an empty string.
 */
function verdictVisual(source: LLMSource | undefined): { text: MessageDescriptor; dot: string } {
  if (!source) return { text: msg`Not checked`, dot: 'bg-muted-foreground/40' };
  if (!source.eligible) return { text: msg`Signed out`, dot: 'bg-amber-500' };
  if (source.authority === 'cached') return { text: msg`Signed in`, dot: 'bg-emerald-500' };
  return { text: msg`Not checked`, dot: 'bg-muted-foreground/40' };
}
