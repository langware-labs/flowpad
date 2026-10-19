import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { ShareButton } from '@src/components/entity-actions/ShareButton';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import { useFileShareSource } from '@src/hooks/use-file-share-source';
import type { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

/**
 * The bar's Share for a file view (a page, a doc, an image, a video), which has
 * no entity until it is shared. Same button as every other target; the file's
 * artifact (a git pointer when it sits in a repo) is resolved only on click, so
 * viewing a file writes nothing.
 */
export function PageShareButton({ dock }: { dock: DockPointer | null }) {
  const { t } = useLingui();
  const [sharing, setSharing] = useState(false);
  const vfs = dock?.vfsPath ?? null;
  // A file, not a folder: folders open in the explorer, and a file has an extension.
  const isFile = !!vfs && dock?.viewType !== ViewType.EXPLORER && /\.[^./\\]+$/.test(vfs.machinePath);
  const path = isFile ? vfs.machinePath : null;
  const source = useFileShareSource(vfs?.typeId, sharing ? path : null);
  if (!path) return null;
  return (
    <>
      <ShareButton
        variant="compact"
        tooltip={t`Share`}
        onClick={() => setSharing(true)}
        testId="entity-actions-share"
      />
      {source && <ShareToConversationDialog open onClose={() => setSharing(false)} source={source} />}
    </>
  );
}
