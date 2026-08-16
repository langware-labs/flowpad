import { AssetCleanupReport, FSRef, launchWizard } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useMemo, useState } from 'react';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { notify } from '@src/notifications';

/** One classified asset — mirrors the backend AssetCleanupFinding. */
export interface CleanupFinding {
  path: string;
  kind: string;
  name: string;
  verdict: 'garbage' | 'keep' | 'unsure' | string;
  reason: string;
  root: string;
  /** Flowpad entity id — set for kind === 'project' findings. */
  entity_id?: string;
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

interface FindingsTableProps {
  title: string;
  rows: CleanupFinding[];
  selected: Set<string>;
  onToggle: (path: string, checked: boolean) => void;
  onToggleAll: (paths: string[], checked: boolean) => void;
  /** Mixed-verdict tables (Projects) show the verdict per row. */
  showVerdict?: boolean;
}

/** Findings for one verdict — each row carries a clean-selection checkbox. */
function FindingsTable({ title, rows, selected, onToggle, onToggleAll, showVerdict }: FindingsTableProps) {
  if (!rows.length) return null;
  const paths = rows.map((f) => f.path);
  const selectedCount = paths.filter((p) => selected.has(p)).length;
  const allSelected = selectedCount === rows.length;
  return (
    <div>
      <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Checkbox
          checked={allSelected ? true : selectedCount > 0 ? 'indeterminate' : false}
          onCheckedChange={(checked) => onToggleAll(paths, checked === true)}
          aria-label={`Select all ${title}`}
        />
        {title} ({rows.length})
      </h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-start text-muted-foreground">
            <th className="w-6" />
            <th className="font-medium">
              <Trans>asset</Trans>
            </th>
            <th className="w-14 font-medium">
              <Trans>kind</Trans>
            </th>
            {showVerdict && (
              <th className="w-16 font-medium">
                <Trans>verdict</Trans>
              </th>
            )}
            <th className="font-medium">
              <Trans>reason</Trans>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.path} className="border-t border-border/50" title={f.path}>
              <td className="py-1">
                <Checkbox
                  checked={selected.has(f.path)}
                  onCheckedChange={(checked) => onToggle(f.path, checked === true)}
                  aria-label={`Select ${f.name}`}
                />
              </td>
              <td className="truncate py-1 pe-2 text-foreground">{f.name}</td>
              <td className="py-1 pe-2 text-muted-foreground">{f.kind}</td>
              {showVerdict && (
                <td className={`py-1 pe-2 ${f.verdict === 'garbage' ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {f.verdict}
                </td>
              )}
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
 * AssetCleanupReport viewer: headline verdict tiles, per-verdict findings
 * tables with clean-selection checkboxes (garbage pre-selected), and a
 * "Clean up" button that launches the `asset-cleanup-wizard` agent with the
 * selected removals ("remove <X> from <Y>") + the report path. The wizard
 * confirms with the user in chat before deleting anything.
 */
export function AssetCleanupReportAssetEditor({ fsRef, report }: AssetCleanupReportAssetEditorProps) {
  const { t } = useLingui();
  const { doc, error, loading } = useCleanupReportDoc(fsRef);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cleaning, setCleaning] = useState(false);

  const findings = useMemo(() => doc?.findings ?? [], [doc]);
  // One grouping pass: file findings split by verdict, projects held separately.
  const { fileGroups, projectFindings } = useMemo(() => {
    const groups: Record<string, CleanupFinding[]> = { garbage: [], keep: [], unsure: [] };
    const projects: CleanupFinding[] = [];
    for (const f of findings) {
      if (f.kind === 'project') projects.push(f);
      else (groups[f.verdict] ??= []).push(f);
    }
    return { fileGroups: groups, projectFindings: projects };
  }, [findings]);

  // Default clean-selection: garbage FILE assets only. Projects are never
  // pre-selected — deleting a project is destructive (folder + all records).
  useEffect(() => {
    setSelected(new Set(fileGroups.garbage.map((f) => f.path)));
  }, [fileGroups]);

  const onToggle = (path: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });

  const onToggleAll = (paths: string[], checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (checked) next.add(p);
        else next.delete(p);
      }
      return next;
    });

  const startCleanup = async () => {
    const items = findings.filter((f) => selected.has(f.path));
    if (!items.length || cleaning) return;
    setCleaning(true);
    try {
      const plan = items
        .map((f) => {
          if (f.kind === 'project') {
            return `- delete project ${f.name} (entity ${f.entity_id || 'unknown'}) at ${f.path}`;
          }
          const folder = f.path.slice(0, f.path.lastIndexOf('/'));
          return `- remove ${f.name} (${f.kind}) from ${folder}`;
        })
        .join('\n');
      const result = await launchWizard<{ removed?: string[]; failed?: string[] }>('asset-cleanup-wizard', {
        title: t`Asset cleanup`,
        prompt:
          `Remove the garbage assets the user selected in the asset-cleanup ` +
          `report at ${fsRef.path}:\n\n${plan}\n\n` +
          `Present this plan and wait for the user's confirmation before deleting.`,
        payload: {
          reportPath: fsRef.path,
          items: items.map((f) => ({
            name: f.name,
            kind: f.kind,
            path: f.path,
            verdict: f.verdict,
            ...(f.entity_id ? { entity_id: f.entity_id } : {}),
          })),
        },
        targetTypeId: report.typeId?.toString(),
      });
      if (result.status === 'done') {
        const removed = result.data?.removed?.length ?? selected.size;
        notify.success({ title: t`Cleanup complete`, message: t`${removed} assets removed.` });
      } else if (result.status === 'error') {
        notify.error({ title: t`Cleanup failed`, message: result.errorStr || t`The wizard reported an error.` });
      }
    } finally {
      setCleaning(false);
    }
  };

  const fileName = fsRef.path.split('/').pop() ?? 'report.json';
  const dirPath = fsRef.path.slice(0, -fileName.length - 1);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-cleanup-report-editor">
      <AssetEditorHeader fileName={report.name || fileName} dirPath={dirPath} />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading && (
          <p className="text-sm text-muted-foreground">
            <Trans>Loading report…</Trans>
          </p>
        )}
        {error && (
          <p className="text-sm text-destructive">
            <Trans>Failed to load report: {error}</Trans>
          </p>
        )}
        {doc && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
                <StatTile label={t`garbage`} value={String(fileGroups.garbage.length)} />
                <StatTile label={t`unsure`} value={String(fileGroups.unsure.length)} />
                <StatTile label={t`keep`} value={String(fileGroups.keep.length)} />
                <StatTile label={t`roots`} value={String(doc.roots?.length ?? 0)} />
              </div>
              <Button
                size="sm"
                disabled={selected.size === 0 || cleaning}
                onClick={() => void startCleanup()}
                data-testid="asset-cleanup-clean-button"
              >
                {cleaning ? <Trans>Cleaning…</Trans> : <Trans>Clean up ({selected.size})</Trans>}
              </Button>
            </div>

            {doc.roots && doc.roots.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Trans>Scanned roots</Trans>
                </h3>
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {doc.roots.map((r) => (
                    <li key={r} className="truncate font-mono" title={r}>
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {[
              { title: t`Garbage`, rows: fileGroups.garbage },
              { title: t`Unsure`, rows: fileGroups.unsure },
              { title: t`Keep`, rows: fileGroups.keep },
            ].map(({ title, rows }) => (
              <FindingsTable
                key={title}
                title={title}
                rows={rows}
                selected={selected}
                onToggle={onToggle}
                onToggleAll={onToggleAll}
              />
            ))}

            {projectFindings.length > 0 && (
              <div data-testid="asset-cleanup-projects-section">
                <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  <Trans>
                    Deleting a project is permanent: it removes the project folder and every Flowpad record inside it.
                    Projects are never pre-selected — check them deliberately.
                  </Trans>
                </div>
                <FindingsTable
                  title={t`Projects`}
                  rows={projectFindings}
                  selected={selected}
                  onToggle={onToggle}
                  onToggleAll={onToggleAll}
                  showVerdict
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
