import { config, FSRef, FrontMatterFsRef, dataContext, Markdown } from '@sdk';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileQuestion, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { useToast } from '@src/hooks/use-toast';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
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
  const { toast } = useToast();
  const { navigation } = useDockNavigation();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

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

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const saved = await Markdown.createInProject(dataContext.project ?? null, name);
      toast({ title: 'Markdown created', description: `[[${name}]]` });
      void queryClient.invalidateQueries({ queryKey: ['wiki-resolve', name] });
      if (saved.asset_ref) {
        navigation.openDock(DockPointer.forAssetEditor('markdown', saved.asset_ref));
      }
    } catch (err) {
      toast({
        title: 'Could not create markdown',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    } finally {
      setCreating(false);
    }
  }, [name, navigation, queryClient, toast]);

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
      <div className="flex h-full items-center justify-center px-6">
        <div
          className="flex max-w-md flex-col items-center gap-4 text-center"
          data-testid="wiki-not-found"
        >
          <FileQuestion className="h-10 w-10 text-muted-foreground/60" />
          <div>
            <div className="text-lg font-semibold">
              [[{name}]] not found
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              No markdown page exists with this name yet.
            </div>
          </div>
          <Button onClick={() => void handleCreate()} disabled={creating}>
            {creating ? (
              <>
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                Creating…
              </>
            ) : (
              <>Create it</>
            )}
          </Button>
        </div>
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
