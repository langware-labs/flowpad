import { useCallback } from 'react';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { FilePreviewSheet } from './FilePreviewSheet';
import { useFilePreviewStore, type FilePreviewTarget } from './file-preview';

/**
 * Global host for `openFilePreview(target)`. Mounted once near the app root
 * (App.tsx, next to WikiModalRoot) — the global-overlay convention documented
 * in docs/wikitip.md.
 *
 * Owns "Open in editor" too — the sheet itself stays presentation-only.
 */
export function FilePreviewRoot() {
  const target = useFilePreviewStore((s) => s.target);
  const close = useFilePreviewStore((s) => s.close);
  const { navigation } = useDockNavigation();

  const openInEditor = useCallback(
    (t: FilePreviewTarget) => {
      close();
      navigation.openMachinePath(t.path, t.typeId, { line: t.line });
    },
    [navigation, close],
  );

  return <FilePreviewSheet target={target} onClose={close} onOpen={openInEditor} />;
}
