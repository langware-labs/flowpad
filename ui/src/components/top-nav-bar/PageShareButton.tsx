import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { ShareButton } from '@src/components/entity-actions/ShareButton';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import { useFileShareSource } from '@src/hooks/use-file-share-source';
import type { DockPointer } from '@src/navigation/DockPointer';

/**
 * The bar's Share for a standalone `.html` page, which has no entity until it
 * is shared. Same button as every other target; the page's artifact (a git
 * pointer when it sits in a repo) is resolved only on click, so viewing a page
 * writes nothing.
 */
export function PageShareButton({ dock }: { dock: DockPointer | null }) {
  const { t } = useLingui();
  const [sharing, setSharing] = useState(false);
  const vfs = dock?.vfsPath ?? null;
  const path = vfs && /\.html?$/i.test(vfs.machinePath) ? vfs.machinePath : null;
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
