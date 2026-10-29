import { useLingui } from '@lingui/react/macro';
import { copyToClipboard } from '@sdk';
import { Copy, Stethoscope } from 'lucide-react';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { useDiagnoseErrorStore } from './diagnose/diagnose-error-store';
import { detailSections, detailText } from './error-detail';
import { useErrorDetailsStore } from './error-details-store';
import type { NotificationData } from './types';

/**
 * The details popup behind every error/warning's Details button: what failed (request), what came
 * back (answer), any limit, when and how often, and this app. Diagnose seeds a diagnosis with all
 * of it. Mounted once in `main.tsx`, next to `DiagnoseErrorModal`.
 */
export function ErrorDetailsDialog() {
  const shown = useErrorDetailsStore((s) => s.shown);
  const close = useErrorDetailsStore((s) => s.close);
  return (
    <Dialog open={shown !== null} onOpenChange={(open) => !open && close()}>
      {shown && <ErrorDetailsContent data={shown} />}
    </Dialog>
  );
}

function ErrorDetailsContent({ data }: { data: NotificationData }) {
  const { t } = useLingui();
  const open = useErrorDetailsStore((s) => s.open);
  const close = useErrorDetailsStore((s) => s.close);
  const diagnose = useDiagnoseErrorStore((s) => s.open);
  const sections = detailSections(data, {
    request: t`Request`,
    call: t`Call`,
    madeBy: t`Made by`,
    answer: t`Answer`,
    status: t`Status`,
    message: t`Message`,
    errorCode: t`Error code`,
    said: t`Full answer`,
    requestId: t`Request id`,
    limit: t`Limit`,
    rule: t`Rule`,
    usedCap: t`Used / cap`,
    endpoint: t`Endpoint`,
    when: t`When`,
    first: t`First`,
    last: t`Last`,
    times: t`Times`,
    app: t`This app`,
    version: t`Version`,
    log: t`Log`,
  });
  const text = detailText(data, sections);
  const status = data.detail?.response?.status;
  const hidden = data.detail?.hidden ?? [];

  return (
    <DialogContent className="max-w-2xl" data-testid="error-details-dialog">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {data.title}
          {status ? <Badge variant={data.level === 'error' ? 'destructive' : 'secondary'}>HTTP {status}</Badge> : null}
        </DialogTitle>
        {data.message && <DialogDescription className="whitespace-pre-line">{data.message}</DialogDescription>}
      </DialogHeader>
      <div className="max-h-[60vh] overflow-auto pr-1">
        {sections.map((s) => (
          <div key={s.title} className="mt-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.title}</div>
            {s.rows.map(([label, value]) => (
              <div key={label} className="grid grid-cols-[120px_1fr] gap-3 border-b border-border py-1.5 text-sm">
                <div className="text-muted-foreground">{label}</div>
                <div className="whitespace-pre-wrap break-all font-mono text-xs">{value}</div>
              </div>
            ))}
          </div>
        ))}
        {hidden.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t`Hidden errors`}
            </div>
            {hidden.map((h, i) => (
              <button
                key={i}
                type="button"
                data-testid="error-details-hidden"
                onClick={() =>
                  open({
                    id: `${data.id}:hidden:${i}`,
                    level: data.level,
                    title: h.title,
                    detail: h.detail,
                    timestamp: data.timestamp,
                  })
                }
                className="block w-full border-b border-border py-1.5 text-left font-mono text-xs hover:bg-muted"
              >
                {h.detail.request?.method} {h.detail.request?.url} → {h.detail.response?.status}{' '}
                {h.detail.response?.message}
              </button>
            ))}
          </div>
        )}
      </div>
      <DialogFooter className="gap-2">
        <Button variant="outline" onClick={() => void copyToClipboard(text)}>
          <Copy className="h-4 w-4" />
          {t`Copy all`}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            close();
            diagnose(text, data.level === 'warning' ? 'warning' : 'error');
          }}
        >
          <Stethoscope className="h-4 w-4" />
          {t`Diagnose`}
        </Button>
        <Button onClick={close}>{t`Close`}</Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** The Details button an error/warning shows wherever it is listed (toast, warnings popover). */
export function ErrorDetailsButton({ data, className }: { data: NotificationData; className?: string }) {
  const { t } = useLingui();
  const open = useErrorDetailsStore((s) => s.open);
  if (data.level !== 'error' && data.level !== 'warning') return null;
  return (
    <button
      type="button"
      data-testid="error-details-open"
      onClick={(e) => {
        e.stopPropagation();
        open(data);
      }}
      className={className ?? 'rounded bg-muted px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/80'}
    >
      {t`Details`}
    </button>
  );
}
