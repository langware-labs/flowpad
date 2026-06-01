import { apiClient, FSRef, FrontMatterFsRef, dataContext, Markdown, Whiteboard } from '@sdk';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileQuestion, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@src/components/ui/radio-group';
import { Label } from '@src/components/ui/label';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { MarkdownEditor } from './markdown/MarkdownEditor';

interface WikiResolveViewProps {
  /** Decoded wiki name from the `/dock/assets/wiki/<name>` pointer. */
  name: string;
}

interface ResolveResult {
  type: string;
  id: string;
  asset_ref: string;
}

type CreateAsType = 'markdown' | 'whiteboard';

/**
 * Resolves a wiki name to a record's asset_ref via the type-agnostic
 * `/api/v1/wiki/resolve` endpoint. Markdown hits render inline so the
 * URL bar stays at `/dock/assets/wiki/<name>` (rename-resilient). Other
 * types (whiteboard, future) dispatch via openDock to their dedicated
 * editor — the wiki URL becomes a redirect.
 *
 * On miss: type picker offering "Create as markdown" / "Create as whiteboard".
 */
export function WikiResolveView({ name }: WikiResolveViewProps) {
  const { computeNode } = useAgentContext();
  const typeIdStr = computeNode?.typeId?.toString();
  const { navigation } = useDockNavigation();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [createAs, setCreateAs] = useState<CreateAsType>('markdown');

  const { data, isLoading, error } = useQuery<ResolveResult | null>({
    queryKey: ['wiki-resolve', name],
    queryFn: async () => {
      // /wiki/resolve returns the resource shape directly (no {status,data}
      // envelope). Wrap the raw body in {data} so the apiClient interceptor's
      // unconditional `.data.data` extract yields the parsed JSON — same trick
      // dataManager.callAction uses for raw-response endpoints.
      const body = (await apiClient.get<ResolveResult | null>('/wiki/resolve', {
        params: { name },
        transformResponse: (raw: string) => ({ data: JSON.parse(raw) }),
      })) as ResolveResult | null;
      if (!body || typeof body !== 'object' || !('type' in body) || !('id' in body)) return null;
      return body;
    },
    staleTime: 30_000,
  });

  // Whiteboard (and any non-markdown) hits: redirect to the dedicated editor.
  // Markdown stays inline so the URL bar remains at /dock/assets/wiki/<name>.
  useEffect(() => {
    if (!data || data.type === 'markdown' || !data.asset_ref) return;
    navigation.openDock(DockPointer.forAssetEditor(data.type, data.asset_ref));
  }, [data, navigation]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      if (createAs === 'whiteboard') {
        const saved = await Whiteboard.createInProject(dataContext.project ?? null, name);
        notify.success({ title: 'Whiteboard created', message: `[[${name}]]` });
        void queryClient.invalidateQueries({ queryKey: ['wiki-resolve', name] });
        if (saved.asset_ref) {
          navigation.openDock(DockPointer.forAssetEditor('whiteboard', saved.asset_ref));
        }
      } else {
        const saved = await Markdown.createInProject(dataContext.project ?? null, name);
        notify.success({ title: 'Markdown created', message: `[[${name}]]` });
        void queryClient.invalidateQueries({ queryKey: ['wiki-resolve', name] });
        if (saved.asset_ref) {
          navigation.openDock(DockPointer.forAssetEditor('markdown', saved.asset_ref));
        }
      }
    } catch (err) {
      notify.error({
        title: `Could not create ${createAs}`,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCreating(false);
    }
  }, [createAs, name, navigation, queryClient]);

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
            <div className="text-lg font-semibold">[[{name}]] not found</div>
            <div className="mt-1 text-sm text-muted-foreground">
              No page exists with this name yet.
            </div>
          </div>
          <RadioGroup
            value={createAs}
            onValueChange={(v) => setCreateAs(v as CreateAsType)}
            className="flex flex-col items-start gap-2"
            data-testid="wiki-create-as"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="markdown" id="wiki-create-markdown" />
              <Label htmlFor="wiki-create-markdown">Create as Markdown</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="whiteboard" id="wiki-create-whiteboard" />
              <Label htmlFor="wiki-create-whiteboard">Create as Whiteboard</Label>
            </div>
          </RadioGroup>
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

  // Non-markdown hits redirect via the useEffect above. Render a small
  // placeholder until the dock navigates away.
  if (data.type !== 'markdown') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Opening [[{name}]]…
      </div>
    );
  }

  // Markdown hit — inline render so the wiki URL stays put.
  const localTypeId = dataContext.computeNodeTypeId;
  const editorRef = localTypeId
    ? new FrontMatterFsRef(data.asset_ref, localTypeId)
    : new FSRef(data.asset_ref.replace(/^\//, ''), computeNode.typeId);
  void typeIdStr;
  const chatTarget = `markdown-${data.id}`;
  return <MarkdownEditor fsRef={editorRef} chatTarget={chatTarget} />;
}
