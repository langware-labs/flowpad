import { useMemo, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { AgenticProcess, type AutomationResult, type AutomationResultStatus, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { Badge } from '@src/components/ui/badge';
import { OpenSessionButton } from '@src/components/workers/ContextWorkerToolbar';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { CardLine, DetailsList, DetailsToggle } from './StatusCard';

const TONE: Record<AutomationResultStatus, 'success' | 'warning' | 'muted' | 'outline'> = {
  done: 'success',
  expired: 'warning',
  needs_review: 'warning',
  cancelled: 'muted',
  failed: 'outline',
};

/**
 * What an automation posted, as ONE card in place of the message's text: where the run stands (the chip),
 * what happened in a line, the rest folded under Details, and the session it called back one click away.
 */
export function AutomationResultCard({ result }: { result: AutomationResult }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [open, setOpen] = useState(false);
  const session = useMemo(() => (result.session ? new TypeId(result.session) : null), [result.session]);
  const { data: process } = useEntity<AgenticProcess>(session, { enabled: !!session });
  const label: Record<AutomationResultStatus, string> = {
    done: t`Done`,
    expired: t`Expired`,
    cancelled: t`Cancelled`,
    needs_review: t`Needs review`,
    failed: t`Failed`,
  };
  const details = result.details ?? [];
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="automation-result-card" data-status={result.status}>
      <div className="space-y-1 break-words">
        <CardLine name={t`Status`}>
          {/* Failed: a tinted chip with a red border; the text stays the foreground colour. */}
          <Badge
            variant={TONE[result.status]}
            className={result.status === 'failed' ? 'border-red-500/60 bg-red-500/15' : undefined}
            data-testid="automation-result-status"
          >
            {label[result.status] ?? result.status}
          </Badge>
        </CardLine>
        <CardLine name={t`Summary`}>{result.summary}</CardLine>
      </div>
      {(details.length > 0 || session) && (
        <div className="flex items-center gap-2">
          {details.length > 0 && (
            <DetailsToggle open={open} onToggle={() => setOpen((v) => !v)} testId="automation-result-details-toggle" />
          )}
          {session && (
            <OpenSessionButton
              onOpen={() => void navigation.openShellProcess(session.id)}
              title={t`Open the session`}
              name={process?.name ?? undefined}
              testIdPrefix="automation-result"
            />
          )}
        </div>
      )}
      {open && <DetailsList rows={details.map((d) => [d.label, d.value])} testId="automation-result-details" />}
    </div>
  );
}
