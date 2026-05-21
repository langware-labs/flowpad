import { Comment, QueryRequest, TypeId } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useCallback, useMemo } from 'react';

/**
 * List + create + delete `Comment` entities scoped to a markdown doc.
 *
 * Parent linkage is via the entity-graph `scope` (same mechanism use-task-comments
 * uses): `comment.save(docTypeId)` and `QueryRequest({ scope: [docTypeId] })`.
 * Position is in `comment.data.line` (1-based source line), mirroring the
 * Annotation.data convention. When `docTypeId` is falsy the hook returns an
 * empty list and no-op mutators — the feature stays inert for entity-less docs.
 */
export interface DocComment {
  id: string;
  line: number;
  text: string;
  createdAt?: string;
  entity: Comment;
}

export function useDocComments(docTypeId: string | null | undefined) {
  // chatTarget arrives as a serialized TypeId string ("markdown-<uuid>"); the
  // entity store needs a real TypeId object. Parse failure (malformed string)
  // collapses to "no scope" — same behavior as docTypeId == null.
  const parentTypeId = useMemo(() => {
    if (!docTypeId) return null;
    try {
      return new TypeId(docTypeId);
    } catch {
      return null;
    }
  }, [docTypeId]);

  const queryRequest = useMemo(
    () =>
      new QueryRequest({
        type: 'comment',
        scope: parentTypeId ? [parentTypeId] : [],
        name: 'useDocComments',
      }),
    [parentTypeId],
  );

  const {
    data: rawComments = [],
    isLoading,
    error,
    refetch,
  } = useEntitiesQuery<Comment>(queryRequest, { enabled: !!parentTypeId });

  // Project only the comments that carry a line anchor — markdown comments
  // always store {line: N}; comments without it belong to other surfaces.
  const comments = useMemo<DocComment[]>(
    () =>
      rawComments
        .map((c): DocComment | null => {
          const line = Number(c.data?.line);
          if (!Number.isFinite(line) || line < 1) return null;
          return {
            id: c.typeId.toString(),
            line,
            text: c.raw_content ?? '',
            createdAt: c.created_date ? String(c.created_date) : undefined,
            entity: c,
          };
        })
        .filter((c): c is DocComment => c !== null),
    [rawComments],
  );

  const addComment = useCallback(
    async (line: number, text: string): Promise<void> => {
      if (!parentTypeId || !text.trim()) return;
      const comment = new Comment({
        raw_content: text.trim(),
        data: { line },
      });
      await comment.save(parentTypeId);
      await refetch();
    },
    [parentTypeId, refetch],
  );

  const deleteComment = useCallback(
    async (commentEntity: Comment): Promise<void> => {
      await commentEntity.delete();
      await refetch();
    },
    [refetch],
  );

  return { comments, isLoading, error, addComment, deleteComment };
}
