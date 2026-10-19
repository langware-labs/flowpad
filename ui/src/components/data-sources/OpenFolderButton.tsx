/**
 * Open an asset's folder in the OS file browser — ONE action for both halves of
 * a data source: the driver (the template, `agentic-assets/data_driver/<name>/`)
 * and the configured source (the instance, `agentic-assets/data_source/<name>/`).
 * Both rows carry the folder as `asset_ref`, so this takes the path and knows
 * nothing about which kind it is. `SourceMenu`'s "Reveal" item calls the same
 * `revealFolder`, so the button and the menu cannot open a folder two ways.
 */
import { FolderOpen } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { FSRef } from '@sdk';
import { Button } from '@src/components/ui/button';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';

const OPEN_FAILED = msg`Could not open the folder`;

/** Open `path` on this machine in the OS file browser; a failure is a toast, never a throw. */
export function revealFolder(path: string): void {
  new FSRef(path, LOCAL_COMPUTE_NODE)
    .open()
    .catch((error) => notify.error({ title: i18n._(OPEN_FAILED), message: errorMessage(error, path) }));
}

/** Renders nothing without a path — a row written before its folder existed has none to open. */
export function OpenFolderButton({ path, testId }: { path: string | null | undefined; testId?: string }) {
  const { t } = useLingui();
  if (!path) return null;
  const label = t`Open folder: ${path}`;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 w-7 p-0"
      title={label}
      aria-label={label}
      data-testid={testId}
      onClick={(e) => {
        // Rows are clickable; opening a folder must not also open the row.
        e.stopPropagation();
        revealFolder(path);
      }}
    >
      <FolderOpen className="size-3.5" />
    </Button>
  );
}
