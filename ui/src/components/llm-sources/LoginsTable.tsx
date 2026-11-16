/**
 * The Logins tab of LLM sources: one row per assistant — its own login, the account it is signed in
 * as, and the source it runs on now (the resolver's answer, the one a spawn uses). Same table as the
 * API keys and LLM Endpoints tabs. A row opens that assistant's sources (`logins/<worker>`).
 */
import { LoginState, type LLMFundingStatus, type StatusRecord } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';

import { statusTextFor } from '@src/components/harness-login/HarnessSignInDialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';

import { harnessKinds, labelForWorker, resolvedLabel, workerOf } from './use-llm-sources';

function LoginBadge({ login }: { login: LoginState | undefined }) {
  // The sign-in dialog's own wording and colour for each state — one map, not two.
  const { label, tone } = statusTextFor(login ?? LoginState.NA);
  return (
    <span className={`text-xs font-medium ${tone}`} data-testid={`login-badge-${login ?? 'none'}`}>
      {label}
    </span>
  );
}

export function LoginsTable({
  status,
  record,
  onOpen,
}: {
  status: LLMFundingStatus;
  record: StatusRecord | null | undefined;
  onOpen: (worker: string) => void;
}) {
  const { t } = useLingui();
  const kinds = harnessKinds(status);
  return (
    <div className="rounded-md border" data-testid="llm-logins">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Assistant</Trans>
            </TableHead>
            <TableHead>
              <Trans>Login</Trans>
            </TableHead>
            <TableHead>
              <Trans>Account</Trans>
            </TableHead>
            <TableHead>
              <Trans>Using now</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {kinds.map((kind) => {
            const worker = workerOf(kind);
            const harness = record?.harnesses.find((h) => h.kind === kind);
            return (
              <TableRow
                key={kind}
                className="cursor-pointer"
                data-testid={`llm-login-row-${worker}`}
                onClick={() => onOpen(worker)}
              >
                <TableCell className="font-medium">{harness?.label || labelForWorker(worker)}</TableCell>
                <TableCell>
                  <LoginBadge login={harness?.login} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{harness?.account?.identity || '—'}</TableCell>
                <TableCell className="text-sm" data-testid={`llm-login-using-${worker}`}>
                  {resolvedLabel(status, kind, t`nothing eligible`)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
