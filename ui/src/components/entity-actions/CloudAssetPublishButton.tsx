import { useMemo, useState } from 'react';
import { Cloud, CloudUpload } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';

import { dataManager } from '@sdk';
import type { TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { compactEntityActionClassName } from './action-button-styles';

interface CloudAssetPublishButtonProps {
  typeId: TypeId;
  variant: 'prominent' | 'compact';
}

/**
 * Publish a TypeInfo-opted-in Git asset through the entity's standard Share
 * action. Git/Hub behavior stays backend-owned; this is only capability chrome.
 */
export function CloudAssetPublishButton({ typeId, variant }: CloudAssetPublishButtonProps) {
  const { t } = useLingui();
  const { data: entity } = useEntity(typeId);
  const typeInfo = useMemo(() => dataManager.getTypeInfo(typeId.type), [typeId.type]);
  const [busy, setBusy] = useState(false);
  // Derived, never mirrored into state: ``share()`` adopts the backend's
  // canonical entity, which is the only thing allowed to declare ``remote``.
  const published = Boolean(entity?.remote);

  if (typeInfo?.cloud_file_transport !== 'git') return null;

  const publish = async () => {
    if (!entity || published || busy) return;
    setBusy(true);
    try {
      await entity.share();
      notify.success({ title: t`Published`, message: t`The asset is now available to project members.` });
    } catch (error) {
      notify.error({
        title: t`Could not publish asset`,
        message: errorMessage(error, t`Publish failed.`),
      });
    } finally {
      setBusy(false);
    }
  };

  const title = published ? t`Published to cloud` : t`Publish to cloud`;
  const Icon = published ? Cloud : CloudUpload;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-testid="asset-cloud-publish"
      data-state={published ? 'published' : 'local'}
      disabled={!entity || published || busy}
      onClick={() => void publish()}
      className={
        variant === 'compact'
          ? compactEntityActionClassName
          : 'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm disabled:opacity-60'
      }
    >
      <Icon className={busy ? 'h-3.5 w-3.5 animate-pulse' : 'h-3.5 w-3.5'} />
      {variant === 'prominent' && (published ? <Trans>Published</Trans> : <Trans>Publish</Trans>)}
    </button>
  );
}
