/**
 * Browse what an index holds — its documents, then one document's chunks in reading order, each
 * with the heading path it is cited by. Reads the sidecar only, so it costs nothing.
 *
 * The document list is fetched once (and again when `chunkCount` moves — a pass landed); a
 * document's chunks page forward by offset and append.
 */
import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { basename } from '@src/components/asset-manager/asset-row-helpers';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { listChunks, type RagHit } from './rag-service';
import { RagChunkItem } from './RagChunkItem';

const PAGE = 50;

type Doc = { doc_ref: string; chunk_count: number };

export function RagChunkBrowser({ indexId, chunkCount }: { indexId: string; chunkCount: number }) {
  const { t } = useLingui();
  const [documents, setDocuments] = useState<Doc[] | null>(null);
  const [docRef, setDocRef] = useState('');
  const [chunks, setChunks] = useState<RagHit[]>([]);
  const [total, setTotal] = useState(0);

  const fail = useCallback(
    (error: unknown) => notify.error({ title: t`Could not read the index`, message: errorMessage(error, '') }),
    [t],
  );

  // The document list; the smallest unscoped page carries it.
  useEffect(() => {
    let live = true;
    listChunks(indexId, { limit: 1 })
      .then(({ documents: docs = [] }) => {
        if (!live) return;
        setDocuments(docs);
        setDocRef((current) => (docs.some((d) => d.doc_ref === current) ? current : docs[0]?.doc_ref ?? ''));
      })
      .catch(fail);
    return () => {
      live = false;
    };
  }, [indexId, chunkCount, fail]);

  // The chosen document's first page.
  useEffect(() => {
    if (!docRef) return;
    let live = true;
    listChunks(indexId, { docRef, limit: PAGE })
      .then((page) => {
        if (!live) return;
        setChunks(page.chunks);
        setTotal(page.total);
      })
      .catch(fail);
    return () => {
      live = false;
    };
  }, [indexId, docRef, chunkCount, fail]);

  const more = () =>
    listChunks(indexId, { docRef, offset: chunks.length, limit: PAGE })
      .then((page) => setChunks((shown) => [...shown, ...page.chunks]))
      .catch(fail);

  if (!documents) return null;
  if (!documents.length) {
    return (
      <p className="mt-3 text-sm text-muted-foreground" data-testid="rag-browse-empty">
        <Trans>Nothing indexed yet.</Trans>
      </p>
    );
  }

  return (
    <div className="mt-3 grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-3" data-testid="rag-browse">
      <ul className="max-h-96 space-y-0.5 overflow-y-auto border-e border-border pe-2" data-testid="rag-browse-docs">
        {documents.map((doc) => (
          <li key={doc.doc_ref}>
            <button
              type="button"
              title={doc.doc_ref}
              data-testid={`rag-browse-doc:${basename(doc.doc_ref)}`}
              onClick={() => setDocRef(doc.doc_ref)}
              className={cn(
                'flex w-full items-center gap-2 rounded px-2 py-1 text-start text-xs hover:bg-muted',
                doc.doc_ref === docRef && 'bg-muted font-medium',
              )}
            >
              <span className="truncate">{basename(doc.doc_ref)}</span>
              <span className="ms-auto tabular-nums text-muted-foreground">{doc.chunk_count}</span>
            </button>
          </li>
        ))}
      </ul>

      <ol className="max-h-96 space-y-2 overflow-y-auto" data-testid="rag-browse-chunks">
        {chunks.map((chunk) => (
          <li key={chunk.chunk_id} className="rounded border border-border">
            <RagChunkItem hit={chunk} />
          </li>
        ))}
        {chunks.length < total && (
          <li>
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => void more()}>
              <Trans>
                Show more ({chunks.length} of {total})
              </Trans>
            </button>
          </li>
        )}
      </ol>
    </div>
  );
}
