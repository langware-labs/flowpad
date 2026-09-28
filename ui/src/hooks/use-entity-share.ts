import { useCallback, useMemo } from 'react';
import { useEntity } from '@sdk/react/hooks';
import { AgenticProcess, TypeId } from '@sdk';
import { useDockNavigation } from '@src/navigation';

export interface UseEntityShareResult {
  /** Resolve the entity's deep-link URL and write it to the clipboard. */
  copyLink(): Promise<string>;
  /** True once the entity has loaded and is shareable. */
  canShare: boolean;
  /** True iff this typeId resolves to an AgenticProcess (used by callers to
   *  pick the transcript-sharing ShareSource for the conversation share). */
  isAgenticProcess: boolean;
}

function resolveDockPointer(entity: any) {
  if (!entity) return null;
  // AgenticProcess: prefer the terminal pointer (attach-to-PTY), it's the canonical shareable URL.
  if (entity instanceof AgenticProcess) return entity.terminalDockPointer;
  const anyEntity = entity as { dockPointer?: unknown };
  return (anyEntity.dockPointer as any) ?? null;
}

/**
 * Generic entity share hook — the LINK half of sharing (the offline file is
 * ``DownloadMessageForm``). The
 * conversation/email share now lives in the contact-first
 * ``ShareToConversationDialog`` (driven by a ShareSource); this hook only
 * exposes copy-link and export-bundle, plus ``isAgenticProcess`` so callers
 * can choose the right ShareSource.
 */
export function useEntityShare(typeId: TypeId | null): UseEntityShareResult {
  const { data: entity } = useEntity<any>(typeId);
  const { navigation } = useDockNavigation();

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

  return {
    copyLink,
    canShare,
    isAgenticProcess,
  };
}
