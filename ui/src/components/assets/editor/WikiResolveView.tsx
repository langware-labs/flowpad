import {
  dataContext,
  FSRef,
  Markdown,
  PageId,
  TypeId,
  Whiteboard,
  type APIEntity,
  type WikiResolveResult,
} from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, FileQuestion, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@src/components/ui/radio-group';
import { Label } from '@src/components/ui/label';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { DockPointer } from '@src/navigation/DockPointer';
import { DEFAULT_WIKI_SPACE, editorForType } from '@src/navigation/asset-doc-types';
import {
  clearWikiResolveResult,
  useWikiResolveResult,
} from '@src/routes/loaders/wiki-resolve-store';
import { resolveWikiWord } from '@src/components/wiki/resolve-wiki';
import type { WikiAuthority } from '@src/components/wiki/resolve-wiki';
import { useWikiModalStore } from '@src/components/wiki-tip/wiki-modal';
import { entityReloadKey } from '@src/utils/entity-reload-key';
import { AssetEditorRouter } from './AssetEditorRouter';
import { MarkdownEditor } from './markdown/MarkdownEditor';
import { useDocTranslations } from './translations/useDocTranslations';

interface WikiResolveViewProps {
  /** Decoded word from the `/dock/.../assets/wiki/<wiki-ref>/<word>` pointer. */
  name: string;
  /** Wiki UUID/@uname, or the local project-scoped `@local` alias. */
  space?: string;
  /** Optional heading slug to scroll to once rendered. */
  fragment?: string;
  /** Read-only body used by WikiTip and the Hub surface. */
  variant?: 'full' | 'plain';
  /** Selects the local graph or the authenticated Hub graph transport. */
  authority?: WikiAuthority;
}

type CreateAsType = 'markdown' | 'whiteboard';

/**
 * Render a Wiki target at its Wiki Dock URL.
 *
 * The route loader resolves the word and writes active context. This component
 * consumes that cached result; WikiTip's non-route modal uses the same typed SDK
 * resolver as a fallback. Content is always fetched from target.record().mainRef.
 */
export function WikiResolveView({
  name,
  space = DEFAULT_WIKI_SPACE,
  fragment,
  variant = 'full',
  authority = 'local',
}: WikiResolveViewProps) {
  const { currentDock } = useDockNavigation();
  const routeResult = useWikiResolveResult(space, name, authority);
  const allowLocalAlias = authority === 'local' && currentDock?.page !== PageId.HUB;
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [createAs, setCreateAs] = useState<CreateAsType>('markdown');
  const { t } = useLingui();

  const queryKey = useMemo(
    () => ['wiki-resolve', authority, space, name, allowLocalAlias] as const,
    [authority, space, name, allowLocalAlias],
  );
  const {
    data: queriedResult,
    isLoading,
    error,
  } = useQuery<WikiResolveResult>({
    queryKey,
    queryFn: () => resolveWikiWord(space, name, { allowLocalAlias, authority }),
    initialData: routeResult,
    enabled: routeResult === undefined,
  });
  const result = routeResult ?? queriedResult;

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      if (createAs === 'whiteboard') {
        await Whiteboard.createInProject(dataContext.project ?? null, name);
        notify.success({ title: t`Whiteboard created`, message: `[[${name}]]` });
      } else {
        await Markdown.createInProject(dataContext.project ?? null, name);
        notify.success({ title: t`Markdown created`, message: `[[${name}]]` });
      }
      clearWikiResolveResult(space, name, authority);
      await queryClient.invalidateQueries({ queryKey });
    } catch (err) {
      notify.error({
        title: `Could not create ${createAs}`,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCreating(false);
    }
  }, [authority, createAs, name, queryClient, queryKey, space, t]);

  if (!result && isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        <Trans>Resolving [[{name}]]…</Trans>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Failed to resolve [[{name}]]: {String(error)}
      </div>
    );
  }

  if (result?.kind === 'ambiguous') {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="flex max-w-md flex-col items-center gap-3 text-center" data-testid="wiki-ambiguous">
          <AlertTriangle className="h-10 w-10 text-amber-500" />
          <div className="text-lg font-semibold"><Trans>[[{name}]] is ambiguous</Trans></div>
          <div className="text-sm text-muted-foreground">
            <Trans>More than one readable asset matches this word. Bind it to a specific asset.</Trans>
          </div>
        </div>
      </div>
    );
  }

  if (!result || result.kind === 'missing') {
    const canCreate = allowLocalAlias && space === DEFAULT_WIKI_SPACE;
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="flex max-w-md flex-col items-center gap-4 text-center" data-testid="wiki-not-found">
          <FileQuestion className="h-10 w-10 text-muted-foreground/60" />
          <div>
            <div className="text-lg font-semibold"><Trans>[[{name}]] not found</Trans></div>
            <div className="mt-1 text-sm text-muted-foreground">
              <Trans>No page exists with this name yet.</Trans>
            </div>
          </div>
          {canCreate ? (
            <>
              <RadioGroup
                value={createAs}
                onValueChange={(value) => setCreateAs(value as CreateAsType)}
                className="flex flex-col items-start gap-2"
                data-testid="wiki-create-as"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="markdown" id="wiki-create-markdown" />
                  <Label htmlFor="wiki-create-markdown"><Trans>Create as Markdown</Trans></Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="whiteboard" id="wiki-create-whiteboard" />
                  <Label htmlFor="wiki-create-whiteboard"><Trans>Create as Whiteboard</Trans></Label>
                </div>
              </RadioGroup>
              <Button onClick={() => void handleCreate()} disabled={creating}>
                {creating ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    <Trans>Creating…</Trans>
                  </>
                ) : <Trans>Create it</Trans>}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <ResolvedWikiAsset
      target={result.target_typeid}
      name={name}
      wikiRef={space}
      fragment={fragment}
      variant={variant}
      authority={authority}
    />
  );
}

interface ResolvedWikiAssetProps {
  target: TypeId;
  name: string;
  wikiRef: string;
  fragment?: string;
  variant: 'full' | 'plain';
  authority: WikiAuthority;
}

function ResolvedWikiAsset({
  target,
  name,
  wikiRef,
  fragment,
  variant,
  authority,
}: ResolvedWikiAssetProps) {
  const editor = editorForType(target.type);
  if (!editor) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>No asset editor is registered for this Wiki target.</Trans>
      </div>
    );
  }
  if (variant === 'plain') {
    return (
      <WikiPlainRecordView
        target={target}
        name={name}
        wikiRef={wikiRef}
        fragment={fragment}
        authority={authority}
      />
    );
  }
  return (
    <AssetEditorRouter
      pointer={AssetDocPointer.forTypeId(editor, target).toPointer()}
      fragment={fragment}
    />
  );
}

function WikiPlainRecordView({
  target,
  name,
  wikiRef,
  fragment,
  authority,
}: Omit<ResolvedWikiAssetProps, 'variant'>) {
  const { data: entity, isLoading: entityLoading, error: entityError } = useEntity(target);
  const {
    data: record,
    isLoading: recordLoading,
    error: recordError,
  } = useQuery({
    queryKey: ['asset-record-refs', authority, target.toString()],
    queryFn: () => entity!.record({ hubReflect: authority === 'hub' }),
    enabled: !!entity,
  });

  if (entityLoading || recordLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        <Trans>Loading [[{name}]]…</Trans>
      </div>
    );
  }
  if (entityError || recordError || !entity || !record?.mainRef) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>This Wiki target has no readable content.</Trans>
      </div>
    );
  }

  return (
    <WikiPlainMarkdown
      entity={entity}
      mainRef={record.mainRef}
      wikiRef={wikiRef}
      name={name}
      fragment={fragment}
      authority={authority}
    />
  );
}

function WikiPlainMarkdown({
  entity,
  mainRef,
  wikiRef,
  name,
  fragment,
  authority,
}: {
  entity: APIEntity<any>;
  mainRef: FSRef;
  wikiRef: string;
  name: string;
  fragment?: string;
  authority: WikiAuthority;
}) {
  const { navigation } = useDockNavigation();
  const closeModal = useWikiModalStore((state) => state.setOpen);
  const chatTarget = entity.typeId.toString();
  const baseReloadKey = entityReloadKey(entity.updated_date);
  const { editorRef, reloadKey, languageSwitcher } = useDocTranslations({
    entity,
    chatTarget,
    assetRef: mainRef.path,
    baseEditorRef: mainRef,
    baseReloadKey,
  });

  const openFull = () => {
    closeModal(false);
    const pointer = DockPointer.forWiki(name, undefined, wikiRef, fragment);
    navigation.openDock(authority === 'hub' ? pointer.withPage(PageId.HUB) : pointer);
  };

  return (
    <MarkdownEditor
      fsRef={editorRef}
      chatTarget={chatTarget}
      fragment={fragment}
      reloadKey={reloadKey}
      variant="plain"
      wikiLinkTarget={{
        page: authority === 'hub' ? PageId.HUB : PageId.DESK,
        space: wikiRef,
      }}
      plainHeaderActions={(share) => (
        <>
          {authority === 'local' ? (
            <Button variant="ghost" size="sm" onClick={openFull} title="Open full page" className="gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </Button>
          ) : null}
          {share}
          {languageSwitcher}
        </>
      )}
    />
  );
}
