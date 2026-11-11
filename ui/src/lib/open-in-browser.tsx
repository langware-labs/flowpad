import { useLingui } from '@lingui/react/macro';
import { Globe } from 'lucide-react';
import { FSRef, type TypeId } from '@sdk';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { cn } from '@src/lib/utils';

export const isHtmlPath = (path: string) => /\.html?$/i.test(path);

/** The ref itself when the system browser can open it — an HTML file on a machine's own disk — else null. */
export const browserOpenable = (ref: FSRef): FSRef | null =>
  isHtmlPath(ref.path) && ref.localComputeNodeId ? ref : null;

/** `browserOpenable` for a path; hub-backed refs and non-HTML paths give null. */
export function localHtmlRef(path: string | null | undefined, typeId: TypeId = LOCAL_COMPUTE_NODE): FSRef | null {
  return path ? browserOpenable(new FSRef(path, typeId)) : null;
}

/** The globe that opens an HTML file in the system's default browser. Each host passes its own button styling. */
export function OpenInBrowserButton({
  fileRef,
  className,
  iconClassName = 'h-4 w-4',
  testId,
}: {
  fileRef: FSRef;
  className?: string;
  iconClassName?: string;
  testId?: string;
}) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      title={t`Open in browser`}
      aria-label={t`Open in browser`}
      data-testid={testId}
      onClick={(e) => {
        // Hosts like the attachment card sit inside a clickable parent.
        e.preventDefault();
        e.stopPropagation();
        void fileRef.open();
      }}
      className={cn(className)}
    >
      <Globe className={iconClassName} />
    </button>
  );
}
