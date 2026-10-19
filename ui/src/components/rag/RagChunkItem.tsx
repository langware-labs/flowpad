/**
 * One stored chunk, clickable to open its document — the row a search hit and the chunk browser
 * share, so the two cannot drift. `score` is shown only for a search hit.
 */
import { basename } from '@src/components/asset-manager/asset-row-helpers';
import type { RagHit } from './rag-service';
import { useOpenRagDoc } from './use-open-rag-doc';

export function RagChunkItem({ hit, score }: { hit: RagHit; score?: number }) {
  const openDoc = useOpenRagDoc();
  return (
    <button
      type="button"
      className="w-full rounded p-1 text-start hover:bg-muted"
      title={hit.doc_ref}
      data-testid="rag-hit"
      onClick={() => openDoc(hit.doc_ref)}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{basename(hit.doc_ref)}</span>
        <span className="truncate">{hit.heading_path.join(' › ')}</span>
        {score !== undefined && <span className="ms-auto tabular-nums text-foreground">{score.toFixed(3)}</span>}
      </div>
      <p className={score !== undefined ? 'line-clamp-2 text-sm text-muted-foreground' : 'whitespace-pre-wrap break-words text-sm'}>
        {hit.text}
      </p>
    </button>
  );
}
