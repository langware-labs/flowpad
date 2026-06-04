import { Comment, QueryRequest, TypeId } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useCallback, useMemo } from 'react';

/**
 * List + create + delete `Comment` entities scoped to a markdown doc.
 *
 * Parent linkage is the canonical `parent_type_id` ("<type>-<id>") on the
 * comment itself, filtered client-side. We DO also pass the scope to
 * `comment.save()` so the backend's add_child relationship lands, but the
 * entity-graph scope query is permissive (returns matching-type entities
 * regardless of parent), so without the parent_type_id filter, every doc would
 * see every other doc's comments. Mirrors the use-annotations pattern.
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

  const parentKey = parentTypeId?.toString() ?? null;

  // Filter to comments anchored to a line AND tagged for this parent. The
  // server-side scope query returns every comment regardless of parent, so the
  // parent_type_id check is what keeps doc A's comments out of doc B's gutter.
  const comments = useMemo<DocComment[]>(
    () =>
      rawComments
        .map((c): DocComment | null => {
          if (!parentKey || c.parent_type_id !== parentKey) return null;
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
    [rawComments, parentKey],
  );

  const addComment = useCallback(
    async (line: number, text: string): Promise<void> => {
      if (!parentTypeId || !parentKey || !text.trim()) return;
      const comment = new Comment({
        raw_content: text.trim(),
        parent_type_id: parentKey,
        data: { line },
      });
      await comment.save(parentTypeId);
      await refetch();
    },
    [parentTypeId, parentKey, refetch],
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
