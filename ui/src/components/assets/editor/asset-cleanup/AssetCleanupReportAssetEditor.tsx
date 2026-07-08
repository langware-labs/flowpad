import { AssetCleanupReport, FSRef } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';

/** One classified asset — mirrors the backend AssetCleanupFinding. */
export interface CleanupFinding {
  path: string;
  kind: string;
  name: string;
  verdict: 'garbage' | 'keep' | 'unsure' | string;
  reason: string;
  root: string;
}

interface CleanupReportDoc {
  id?: string;
  name?: string;
  roots?: string[];
  findings?: CleanupFinding[];
  summary?: Record<string, number>;
  markdown?: string;
}

/** Loads + parses the report.json behind an AssetCleanupReport entity. */
function useCleanupReportDoc(fsRef: FSRef | null): {
  doc: CleanupReportDoc | null;
  error: string | null;
  loading: boolean;
} {
  const [doc, setDoc] = useState<CleanupReportDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = fsRef?.path ?? null;

  useEffect(() => {
    if (!fsRef) return;
    let cancelled = false;
    setDoc(null);
    setError(null);
    (async () => {
      try {
        const raw = await fsRef.read();
        if (cancelled) return;
        setDoc(JSON.parse(raw) as CleanupReportDoc);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return { doc, error, loading: !doc && !error };
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col rounded border border-border bg-muted/40 px-3 py-2">
      <span className="text-lg font-semibold text-foreground">{value}</span>
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  );
}

function FindingsTable({ title, rows }: { title: string; rows: CleanupFinding[] }) {
  if (!rows.length) return null;
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title} ({rows.length})
      </h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="font-medium"><Trans>asset</Trans></th>
            <th className="w-14 font-medium"><Trans>kind</Trans></th>
            <th className="font-medium"><Trans>reason</Trans></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.path} className="border-t border-border/50" title={f.path}>
              <td className="truncate py-1 pr-2 text-foreground">{f.name}</td>
              <td className="py-1 pr-2 text-muted-foreground">{f.kind}</td>
              <td className="py-1 text-muted-foreground">{f.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface AssetCleanupReportAssetEditorProps {
  fsRef: FSRef;
  report: AssetCleanupReport;
}

/**
 * AssetCleanupReport viewer: headline verdict tiles, then per-verdict findings
 * tables (garbage first). Identify-only — the report never deletes anything.
 */
export function AssetCleanupReportAssetEditor({ fsRef, report }: AssetCleanupReportAssetEditorProps) {
  const { t } = useLingui();
  const { doc, error, loading } = useCleanupReportDoc(fsRef);

  const fileName = fsRef.path.split('/').pop() ?? 'report.json';
  const dirPath = fsRef.path.slice(0, -fileName.length - 1);
  const findings = doc?.findings ?? [];
  const byVerdict = (verdict: string) => findings.filter((f) => f.verdict === verdict);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-cleanup-report-editor">
      <AssetEditorHeader fileName={report.name || fileName} dirPath={dirPath} />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading && <p className="text-sm text-muted-foreground"><Trans>Loading report…</Trans></p>}
        {error && <p className="text-sm text-destructive"><Trans>Failed to load report: {error}</Trans></p>}
        {doc && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile label={t`garbage`} value={String(byVerdict('garbage').length)} />
              <StatTile label={t`unsure`} value={String(byVerdict('unsure').length)} />
              <StatTile label={t`keep`} value={String(byVerdict('keep').length)} />
              <StatTile label={t`roots`} value={String(doc.roots?.length ?? 0)} />
            </div>

            {doc.roots && doc.roots.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Trans>Scanned roots</Trans>
                </h3>
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {doc.roots.map((r) => (
                    <li key={r} className="truncate font-mono" title={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            <FindingsTable title={t`Garbage`} rows={byVerdict('garbage')} />
            <FindingsTable title={t`Unsure`} rows={byVerdict('unsure')} />
            <FindingsTable title={t`Keep`} rows={byVerdict('keep')} />
          </div>
        )}
      </div>
    </div>
  );
}
