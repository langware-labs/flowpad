/**
 * The files in an asset folder, each one a link that opens it in the editor — a
 * driver's `data_driver.json`, `source.py`, `README.md` and `tests/`, or a
 * source's `data_source.json`. One level of subfolders is listed inline (a
 * driver's `tests/`); caches are not.
 *
 * Opening goes through `navigation.openMachinePath` / `openFolder`, the same seams
 * every other surface holding a real path uses, so the editor's address bar and
 * history behave as they do anywhere else.
 */
import { useEffect, useState } from 'react';
import { fsManager } from '@sdk';
import { FileCode2, Folder } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';

type Entry = { path: string; rel: string; isDir: boolean };

const HIDDEN = new Set(['__pycache__', '.pytest_cache', 'node_modules', '.DS_Store']);

async function listFolder(folder: string): Promise<Entry[]> {
  const top = await fsManager.listDirectory(LOCAL_COMPUTE_NODE, folder);
  const out: Entry[] = [];
  for (const item of top.items.filter((i) => !HIDDEN.has(i.name)).sort(byDirThenName)) {
    const path = `${folder}/${item.name}`;
    out.push({ path, rel: item.name, isDir: !!item.is_dir });
    if (!item.is_dir) continue;
    const inner = await fsManager.listDirectory(LOCAL_COMPUTE_NODE, path).catch(() => null);
    for (const child of (inner?.items ?? []).filter((i) => !HIDDEN.has(i.name) && !i.is_dir).sort(byDirThenName)) {
      out.push({ path: `${path}/${child.name}`, rel: `${item.name}/${child.name}`, isDir: false });
    }
  }
  return out;
}

function byDirThenName(a: { name: string; is_dir?: boolean }, b: { name: string; is_dir?: boolean }) {
  return Number(!!a.is_dir) - Number(!!b.is_dir) || a.name.localeCompare(b.name);
}

export function AssetFolderFiles({ folder, testId }: { folder: string | null | undefined; testId?: string }) {
  const { navigation } = useDockNavigation();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setEntries(null);
    setFailed(false);
    if (!folder) return;
    listFolder(folder)
      .then((found) => live && setEntries(found))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [folder]);

  if (!folder) return null;
  if (failed)
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>Could not list the folder.</Trans>
      </p>
    );
  if (!entries)
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>Loading files…</Trans>
      </p>
    );

  return (
    <div data-testid={testId} className="overflow-hidden rounded-lg border border-border text-sm">
      {entries.map((entry) => {
        const Icon = entry.isDir ? Folder : FileCode2;
        return (
          <button
            key={entry.path}
            type="button"
            title={entry.path}
            data-testid={`asset-file-${entry.rel}`}
            className="flex w-full items-center gap-2 border-b border-border px-3 py-1.5 text-start font-mono text-xs last:border-b-0 hover:bg-accent/50"
            onClick={() =>
              entry.isDir ? navigation.openFolder(entry.path) : navigation.openMachinePath(entry.path, LOCAL_COMPUTE_NODE)
            }
          >
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{entry.rel}</span>
          </button>
        );
      })}
    </div>
  );
}
