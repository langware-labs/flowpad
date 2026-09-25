/**
 * Open an asset's folder in the OS file browser — ONE control for both halves of
 * a data source: the driver (the template, `agentic-assets/data_driver/<name>/`)
 * and the configured source (the instance, `agentic-assets/data_source/<name>/`).
 * Both rows carry the folder as `asset_ref`, so the button takes the path and
 * knows nothing about which kind it is.
 *
 * Same seam the asset list's scope cell uses (`openExternalFromComputeNode`): the
 * backend opens the path on this machine. Renders nothing without a path — a row
 * written before its folder existed has none to open.
 */
import { FolderOpen } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { openExternalFromComputeNode } from '@sdk/entities/compute-node';
import { Button } from '@src/components/ui/button';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';

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
        openExternalFromComputeNode('@local', path).catch((err) =>
          notify.error({ title: t`Could not open the folder`, message: errorMessage(err, path) }),
        );
      }}
    >
      <FolderOpen className="size-3.5" />
    </Button>
  );
}
