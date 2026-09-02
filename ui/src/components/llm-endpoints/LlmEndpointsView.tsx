/**
 * LLM endpoints — the hub page's screen for roots, chains, filters/limits and
 * usage. URL: `/dock/hub/llm-endpoints[/<id>[/overview|usage|models]]`.
 *
 * URL-first: the selected endpoint and its tab come from the pointer, and every
 * click that changes them is an `openPage` navigation. This owns the add/edit
 * dialog and the delete confirm (one instance each, driven by a nullable
 * target — the house pattern), so rows and the detail hold no dialogs.
 */
import { PageId, ViewType, dataManager, type LLMEndpoint } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { Waypoints } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { errorMessage } from '@src/lib/error-message';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';

import { LlmEndpointDetail } from './LlmEndpointDetail';
import { LlmEndpointDialog } from './LlmEndpointDialog';
import { ShareEndpointDialog } from './ShareEndpointDialog';
import { LlmEndpointsList } from './LlmEndpointsList';
import { openLlmEndpoint, parseLlmEndpointsPointer, type LlmEndpointTab } from './llm-endpoints-pointer';
import { useLlmEndpoints } from './use-llm-endpoints';

export function LlmEndpointsView({ pointer }: { pointer?: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { endpoints, isLoading, refetch } = useLlmEndpoints();
  const { id: selectedId, tab } = parseLlmEndpointsPointer(pointer);
  const selected = useMemo(() => endpoints.find((e) => e.id === selectedId) ?? null, [endpoints, selectedId]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<LLMEndpoint | null>(null);
  const [deleting, setDeleting] = useState<LLMEndpoint | null>(null);
  const [sharing, setSharing] = useState<LLMEndpoint | null>(null);

  const go = useCallback(
    (id?: string, nextTab?: LlmEndpointTab) =>
      id ? openLlmEndpoint(navigation, id, nextTab) : navigation.openPage(PageId.HUB, ViewType.LLM_ENDPOINTS),
    [navigation],
  );

  const openAdd = useCallback(() => {
    setEditing(null);
    setEditorOpen(true);
  }, []);
  const openEdit = useCallback((e: LLMEndpoint) => {
    setEditing(e);
    setEditorOpen(true);
  }, []);

  const confirmDelete = useCallback(
    async (e: LLMEndpoint) => {
      try {
        await dataManager.delete(e.typeId);
        void refetch();
        if (selectedId === e.id) go();
      } catch (error) {
        notify.error({
          title: t`Could not delete ${e.name}`,
          message: errorMessage(error, t`The endpoint was not removed.`),
        });
      }
    },
    [refetch, selectedId, go, t],
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <header className="mb-1 flex items-center gap-2">
        <Waypoints className="size-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">
          <Trans>LLM Endpoints</Trans>
        </h1>
        {endpoints.length > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{endpoints.length}</span>
        )}
      </header>
      <p className="mb-5 max-w-2xl text-sm text-muted-foreground">
        <Trans>
          Roots talk to a provider with a stored key; chains are fed from other endpoints in fallback order and narrow
          what passes with filters and limits. Usage is accumulated along the chain.
        </Trans>
      </p>

      {selectedId ? (
        <LlmEndpointDetail
          endpoint={selected}
          endpointId={selectedId}
          tab={tab}
          all={endpoints}
          onBack={() => go()}
          onTab={(nextTab) => go(selectedId, nextTab)}
          onEdit={openEdit}
          onDelete={setDeleting}
          onShare={setSharing}
        />
      ) : (
        <LlmEndpointsList
          endpoints={endpoints}
          isLoading={isLoading}
          onOpen={(e) => go(e.id)}
          onNew={openAdd}
          onEdit={openEdit}
          onDelete={setDeleting}
        />
      )}

      {/* One dialog instance, driven by a nullable target -- the house pattern for this view: rows
          and the detail hold no dialogs of their own. */}
      <ShareEndpointDialog open={!!sharing} onOpenChange={(next) => !next && setSharing(null)} endpoint={sharing} />

      <LlmEndpointDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editing={editing}
        all={endpoints}
        onSaved={() => void refetch()}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(next) => !next && setDeleting(null)}
        variant="destructive"
        title={t`Delete this endpoint?`}
        description={t`"${deleting?.name ?? ''}" will be removed. Chains that source it will lose that source; its stored key and usage history go with it. This cannot be undone.`}
        confirmLabel={t`Delete`}
        onConfirm={() => deleting && void confirmDelete(deleting)}
      />
    </div>
  );
}

export default LlmEndpointsView;
