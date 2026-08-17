import { useMemo } from 'react';
import { useAssetSearch } from '@src/hooks/use-asset-search';
import { projectScope } from '@src/lib/scope-filter';
import { DEFAULT_ASSET_FILTER } from '@src/components/assets/assetFilter';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Trans } from '@lingui/react/macro';
import { FileText, FolderOpen } from 'lucide-react';

/**
 * The desk's guides, grouped by their top-level `docs/` folder.
 *
 * Categories come free from the repo's directory structure — a desk organises
 * its portal by moving files, with no config to keep in sync. That is also why
 * the grouping is derived here rather than declared: research is consistent
 * that users should identify their issue in ≤2 clicks, and folder names written
 * by the desk are already plain language.
 */
export function HelpdeskGuides({ projectId, mountPath }: { projectId: string; mountPath?: string | null }) {
  const { navigation } = useDockNavigation();
  // Spread the default: `applyFilterToParams` reads `tags`/`filters`/`query`
  // unguarded, so a partial filter throws before the request is built.
  const filter = useMemo(() => ({ ...DEFAULT_ASSET_FILTER, scope: projectScope(projectId) }), [projectId]);
  const { results, isLoading } = useAssetSearch({
    recordType: 'markdown',
    filter,
    page: 1,
    pageSize: 200,
  });

  const categories = useMemo(() => {
    const root = mountPath ? `${mountPath.replace(/\/$/, '')}/` : null;
    const byCategory = new Map<string, { title: string; path: string }[]>();

    for (const r of results) {
      // `asset_ref` is absolute; make it repo-relative so the pointer is
      // portable and matches what the article view resolves against.
      const abs = r.asset_ref ?? '';
      const rel = root && abs.startsWith(root) ? abs.slice(root.length) : abs;
      if (!rel.startsWith('docs/')) continue; // only the published guide tree

      const parts = rel.split('/');
      // docs/<category>/<file>.md → category; docs/<file>.md → ungrouped
      const category = parts.length > 2 ? parts[1] : '';
      const list = byCategory.get(category) ?? [];
      list.push({ title: r.title || r.name || parts[parts.length - 1], path: rel });
      byCategory.set(category, list);
    }

    return (
      [...byCategory.entries()]
        .map(([name, articles]) => ({ name, articles: articles.sort((a, b) => a.title.localeCompare(b.title)) }))
        // Ungrouped articles last — they read as loose ends next to named
        // sections. Two-key sort rather than a nested ternary.
        .sort((a, b) => Number(a.name === '') - Number(b.name === '') || a.name.localeCompare(b.name))
    );
  }, [results, mountPath]);

  if (isLoading || categories.length === 0) return null;

  return (
    <section className="flex flex-col gap-2" data-testid="helpdesk-guides">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Trans>Guides</Trans>
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {categories.map((cat) => (
          <div key={cat.name || '_'} className="rounded-lg border border-border p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
              {cat.name || <Trans>More</Trans>}
            </div>
            <ul className="flex flex-col">
              {cat.articles.map((a) => (
                <li key={a.path}>
                  <button
                    type="button"
                    onClick={() => navigation.openDock(DockPointer.forHelpdesk(projectId, a.path))}
                    className="flex w-full items-center gap-2 rounded px-1 py-1 text-start text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                    data-testid="helpdesk-guide-link"
                  >
                    <FileText className="h-3 w-3 shrink-0 opacity-60" />
                    <span className="truncate">{a.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
