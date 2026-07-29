import { dataContext, dataManager, TypeId, Wiki, type WikiResolveResult } from '@sdk';
import { DEFAULT_WIKI_SPACE } from '@src/navigation/asset-doc-types';

export interface ResolveWikiWordOptions {
  /** `@local` is a project-scoped alias only on the local Desk surface. */
  allowLocalAlias?: boolean;
  authority?: WikiAuthority;
}

export type WikiAuthority = 'local' | 'hub';

/**
 * Resolve one Wiki word through the typed graph actions.
 *
 * Route interpretation owns the special local alias; Wiki.resolve owns the
 * actual namespace lookup and returns identity only.
 */
export async function resolveWikiWord(
  wikiRef: string,
  word: string,
  options: ResolveWikiWordOptions = {},
): Promise<WikiResolveResult> {
  if (options.authority === 'hub') {
    return Wiki.resolveHub(wikiRef, word);
  }
  let wiki: Wiki | null;
  if (wikiRef === DEFAULT_WIKI_SPACE && options.allowLocalAlias !== false) {
    wiki = dataContext.project
      ? await dataContext.project.getDefaultWiki()
      : null;
  } else {
    wiki = await dataManager.getByTypeId<Wiki>(new TypeId(Wiki.type, wikiRef));
  }
  return wiki ? wiki.resolve(word) : { kind: 'missing' };
}
