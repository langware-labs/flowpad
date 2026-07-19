import { TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { MarkdownView } from '@src/components/markdown-view';
import { useMemo } from 'react';
import { Trans } from '@lingui/react/macro';

/**
 * HubEntityView — a generic single-entity viewer for the hub page. Loads the
 * entity by `<type>/<id>` and renders its title + a text/markdown content field
 * via the OSS `MarkdownView` (reuse-first — see [[oss-ontology-hub-api-division]]).
 *
 * Content shows for entities whose body is an entity FIELD (e.g. `task.description`).
 * File-backed types (markdown/agentic_flow store their body as files at
 * `asset_ref`) have no field content on the hub → they render metadata only
 * until the OSS content model reads bodies from an entity field.
 *
 * URL: /dock/hub/entity/<type>/<id>
 */

// First non-empty string field is treated as the body. Order = most→least specific.
const CONTENT_FIELDS = ['description', 'raw_content', 'content', 'text', 'body'];

export function HubEntityView({ pointer }: { pointer?: string }) {
  const [type, id] = (pointer || '').split('/');
  const typeId = useMemo(() => (type && id ? new TypeId(type, id) : null), [type, id]);

  // Generic entity load — the concrete type is data-driven, so cast loosely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useEntity<any>(typeId, { enabled: !!typeId });
  const entity = data as Record<string, unknown> | null | undefined;

  const title =
    (typeof entity?.title === 'string' && entity.title) ||
    (typeof entity?.name === 'string' && entity.name) ||
    id ||
    'Entity';

  const content = useMemo(() => {
    if (!entity) return '';
    for (const f of CONTENT_FIELDS) {
      const v = entity[f];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
  }, [entity]);

  if (!typeId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Nothing to show.</Trans>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
        {isLoading ? (
          <p className="text-sm text-muted-foreground"><Trans>Loading…</Trans></p>
        ) : content ? (
          <MarkdownView value={content} />
        ) : (
          <p className="text-sm text-muted-foreground"><Trans>No content.</Trans></p>
        )}
      </div>
    </div>
  );
}

export default HubEntityView;
