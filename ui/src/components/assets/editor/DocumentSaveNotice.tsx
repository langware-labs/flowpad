import { Trans } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import type { MarkdownContentState } from '@src/hooks/use-markdown-content';

type Props = Pick<MarkdownContentState, 'saveError' | 'metadataError' | 'conflict' | 'inspectCurrent' | 'reload' | 'currentDocument'>;

export function DocumentSaveNotice({ saveError, metadataError, conflict, inspectCurrent, reload, currentDocument }: Props) {
  return <>
    {(saveError || metadataError) && <div role="alert" className="flex flex-wrap items-center gap-3 border-b p-3 text-sm text-destructive">
      <span>{conflict ? <Trans>File changed outside this editor. Your edits are preserved.</Trans> : (saveError?.message ?? metadataError)}</span>
      {conflict && <Button variant="outline" size="sm" onClick={() => void inspectCurrent()}><Trans>View current file</Trans></Button>}
      {saveError && <Button variant="outline" size="sm" onClick={reload}><Trans>Discard edits and reload</Trans></Button>}
    </div>}
    {currentDocument && <details className="max-h-64 overflow-auto border-b p-3 text-sm" open>
      <summary><Trans>Current file on disk</Trans></summary>
      <pre className="whitespace-pre-wrap">{currentDocument.raw_text}</pre>
    </details>}
  </>;
}
