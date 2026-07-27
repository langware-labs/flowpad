import { useCallback, useMemo, useState } from 'react';
import { useEntity } from '@sdk/react/hooks';
import {
  createTaskBundle,
  localFlowMessageBundleUrl,
} from '@sdk/entities/flow-message';
import { AgenticProcess, TypeId } from '@sdk';
import { useDockNavigation } from '@src/navigation';

export interface ExportBundleOptions {
  title: string;
  message?: string;
}

export interface ExportBundleResult {
  flowMessageId: string;
  downloadUrl: string;
}

export interface UseEntityShareResult {
  /** Resolve the entity's deep-link URL and write it to the clipboard. */
  copyLink(): Promise<string>;
  /** Package the share into a downloadable .flowmsg bundle. */
  exportBundle(opts: ExportBundleOptions): Promise<ExportBundleResult>;
  /** True once the entity has loaded and is shareable. */
  canShare: boolean;
  /** True iff this typeId resolves to an AgenticProcess (used by callers to
   *  pick the transcript-sharing ShareSource for the conversation share). */
  isAgenticProcess: boolean;
  /** In-flight flag for copyLink/exportBundle. */
  isSharing: boolean;
}

function resolveDockPointer(entity: any) {
  if (!entity) return null;
  // AgenticProcess: prefer the terminal pointer (attach-to-PTY), it's the canonical shareable URL.
  if (entity instanceof AgenticProcess) return entity.terminalDockPointer;
  const anyEntity = entity as { dockPointer?: unknown };
  return (anyEntity.dockPointer as any) ?? null;
}

/**
 * Generic entity share hook — the LINK + BUNDLE half of sharing. The
 * conversation/email share now lives in the contact-first
 * ``ShareToConversationDialog`` (driven by a ShareSource); this hook only
 * exposes copy-link and export-bundle, plus ``isAgenticProcess`` so callers
 * can choose the right ShareSource.
 */
export function useEntityShare(typeId: TypeId | null): UseEntityShareResult {
  const { data: entity } = useEntity<any>(typeId);
  const { navigation } = useDockNavigation();
  const [isSharing, setIsSharing] = useState(false);

  const isAgenticProcess = useMemo(
    () => typeId?.type === AgenticProcess.type,
    [typeId?.type],
  );

  const canShare = !!entity && !!typeId;

  const copyLink = useCallback(async (): Promise<string> => {
    if (!entity) throw new Error('Entity not loaded');
    const pointer = resolveDockPointer(entity);
    if (!pointer) throw new Error('Entity has no shareable dock pointer');
    const url = navigation.getDockUrl(pointer);
    try {
      await navigator.clipboard.writeText(url);
    } catch (err) {
      // Caller surfaces the URL in a fallback toast.
      console.warn('[useEntityShare] clipboard write failed:', err);
      throw err;
    }
    return url;
  }, [entity, navigation]);

  const exportBundle = useCallback(
    async (opts: ExportBundleOptions): Promise<ExportBundleResult> => {
      const title = opts.title.trim();
      if (!title) throw new Error('Title required');
      setIsSharing(true);
      try {
        const result = await createTaskBundle({
          spec_title: '',
          spec_content: '',
          task_title: title,
          message: (opts.message ?? '').trim() || null,
          team_space_id: null,
        });
        const downloadUrl = localFlowMessageBundleUrl(result.flow_message_id);
        return { flowMessageId: result.flow_message_id, downloadUrl };
      } finally {
        setIsSharing(false);
      }
    },
    [],
  );

  return {
    copyLink,
    exportBundle,
    canShare,
    isAgenticProcess,
    isSharing,
  };
}
