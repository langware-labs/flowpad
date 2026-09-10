import { FSRef, TypeId } from '@sdk';
import { useMarkdownContent } from '@src/hooks/use-markdown-content';
import { useMemo } from 'react';
import type { DiscoverItem } from './discover-model';

/** The main document of a folder- or file-shaped asset, relative to the asset's own storage root. */
function deskMainDocument(item: DiscoverItem): string | null {
  if (item.type === 'skill') return 'SKILL.md';
  if (item.type === 'markdown' || item.type === 'subagent') {
    const leaf = (item.relPath ?? '').split('/').filter(Boolean).pop();
    return leaf && leaf.endsWith('.md') ? leaf : null;
  }
  return null;
}

/**
 * The asset's document, read through the ONE `fs` reader both runtimes serve:
 * on the hub the `body_ref` the directory named (a materialized tree), on the
 * desk the entity's own main file. `fsRef` is null when there is nothing to
 * read here, and the caller says why with `bodyCopyKey`.
 */
export function useDiscoverBody(item: DiscoverItem | null, mode: 'hub' | 'desk') {
  const fsRef = useMemo(() => {
    if (!item) return null;
    if (mode === 'hub') {
      const ref = item.body?.body_available ? item.body.body_ref : null;
      return ref ? new FSRef(ref.path, new TypeId(ref.type_id), 'file', true) : null;
    }
    if (item.state === null || item.state === 'missing' || item.state === 'install') return null;
    const main = deskMainDocument(item);
    return main ? new FSRef(main, new TypeId(item.type, item.id), 'file', true) : null;
  }, [item, mode]);
  const content = useMarkdownContent(fsRef, { autoSave: false });
  return { fsRef, ...content };
}
