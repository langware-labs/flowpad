import { config, FSRef, FrontMatterFsRef, dataContext } from '@sdk';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { MarkdownEditor } from './markdown/MarkdownEditor';

interface WikiResolveViewProps {
  /** Decoded wiki name from the `/dock/assets/wiki/<name>` pointer. */
  name: string;
}

interface MarkdownRow {
  id: string;
  name?: string;
  title?: string;
  asset_ref?: string;
}

/**
 * Resolves a wiki name to a markdown record's asset_ref, then mounts the
 * normal markdown editor against it. URL bar stays at `/dock/assets/wiki/<name>`
 * so the link is rename-resilient and shareable.
 *
 * Resolution mirrors `flow_sdk/wiki/resolver.py`: name match (case-insensitive),
 * fall back to title match. Includes system-shipped pages.
 */
export function WikiResolveView({ name }: WikiResolveViewProps) {
  const { computeNode } = useAgentContext();
  const typeIdStr = computeNode?.typeId?.toString();

  const { data, isLoading, error } = useQuery<MarkdownRow | null>({
    queryKey: ['wiki-resolve', name],
    queryFn: async () => {
      const url = `${config.SERVER_URL}${config.API_PREFIXES.graph}/markdown?include_system=true&limit=5000`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`failed to fetch: ${resp.status}`);
      const body = await resp.json();
      const rows: MarkdownRow[] = body.data ?? [];
      const lower = name.toLowerCase();
      return (
        rows.find((r) => (r.name ?? '').toLowerCase() === lower) ??
        rows.find((r) => (r.title ?? '').toLowerCase() === lower) ??
        null
      );
    },
    staleTime: 30_000,
  });

  if (!computeNode?.typeId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Connecting…
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Resolving [[{name}]]…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Failed to resolve [[{name}]]: {String(error)}
      </div>
    );
  }

  if (!data?.asset_ref) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No markdown record found for [[{name}]].
      </div>
    );
  }

  // FrontMatterFsRef matches what PlainMarkdownAssetEditor would have built.
  // chatTarget is taken directly from the resolved entity (`markdown-<id>`)
  // — bypasses the path-based useEntityByPath lookup that misses system docs.
  const localTypeId = dataContext.computeNodeTypeId;
  const editorRef = localTypeId
    ? new FrontMatterFsRef(data.asset_ref, localTypeId)
    : new FSRef(data.asset_ref.replace(/^\//, ''), computeNode.typeId);
  void typeIdStr;
  const chatTarget = `markdown-${data.id}`;
  return <MarkdownEditor fsRef={editorRef} chatTarget={chatTarget} />;
}
