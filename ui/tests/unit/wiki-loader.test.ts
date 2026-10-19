import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dataContext,
  dataManager,
  Project,
  TypeId,
  Wiki,
} from '@sdk';
import { loadAssetRoute } from '@src/routes/loaders/load-asset';
import {
  getWikiResolveResult,
  resetWikiResolveResultsForTests,
} from '@src/routes/loaders/wiki-resolve-store';

const PROJECT_ID = '4f905b7b-6873-4a43-bb19-27c8216ed4bd';
const WIKI_ID = 'f5a5ec65-13f8-4dbd-bca5-6cdba46cf39f';
const TARGET_ID = '261d63fd-4655-4ab6-84bc-3f8b966c7f0e';

afterEach(() => {
  vi.restoreAllMocks();
  resetWikiResolveResultsForTests();
  dataManager.removeEntityFromCache(new TypeId(Project.type, PROJECT_ID));
  dataManager.removeEntityFromCache(new TypeId(Wiki.type, WIKI_ID));
  dataManager.removeEntityFromCache(new TypeId('markdown', TARGET_ID));
});

describe('Wiki asset loader', () => {
  it('maps @local through the selected Project before resolving and installing context', async () => {
    const project = new Project({ id: PROJECT_ID });
    const wiki = new Wiki({ id: WIKI_ID });
    const target = { typeId: new TypeId('markdown', TARGET_ID) };
    const defaultWiki = vi.spyOn(project, 'getDefaultWiki').mockResolvedValue(wiki);
    const resolve = vi.spyOn(wiki, 'resolve').mockResolvedValue({
      kind: 'resolved',
      target_typeid: target.typeId,
      source: 'implicit',
    });
    vi.spyOn(dataContext, 'getContextEntity').mockReturnValue(project);
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue(target as never);
    const setActive = vi.spyOn(dataContext, 'setActiveEntityTypeId').mockResolvedValue();

    await loadAssetRoute('wiki/@local/Quick start');

    expect(defaultWiki).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith('Quick start');
    expect(setActive).toHaveBeenCalledWith(target.typeId);
    expect(getWikiResolveResult('@local', 'Quick start')).toMatchObject({
      kind: 'resolved',
      source: 'implicit',
    });
  });

  it.each(['missing', 'ambiguous'] as const)(
    'does not install a target for %s',
    async (kind) => {
      const project = new Project({ id: PROJECT_ID });
      const wiki = new Wiki({ id: WIKI_ID });
      vi.spyOn(project, 'getDefaultWiki').mockResolvedValue(wiki);
      vi.spyOn(wiki, 'resolve').mockResolvedValue({ kind });
      vi.spyOn(dataContext, 'getContextEntity').mockReturnValue(project);
      const setActive = vi.spyOn(dataContext, 'setActiveEntityTypeId').mockResolvedValue();

      await loadAssetRoute('wiki/@local/Quick start');

      expect(setActive).not.toHaveBeenCalled();
      expect(getWikiResolveResult('@local', 'Quick start')).toEqual({ kind });
    },
  );

  it('resolves a Hub Wiki through the Hub bridge and never interprets @local ambiently', async () => {
    const resolveHub = vi.spyOn(Wiki, 'resolveHub').mockResolvedValue({ kind: 'missing' });
    const getByTypeId = vi.spyOn(dataManager, 'getByTypeId');

    await loadAssetRoute(`wiki/${WIKI_ID}/Quick start`, {
      allowLocalWikiAlias: false,
      wikiAuthority: 'hub',
    });

    expect(resolveHub).toHaveBeenCalledWith(WIKI_ID, 'Quick start');
    expect(getByTypeId).not.toHaveBeenCalled();
    expect(getWikiResolveResult(WIKI_ID, 'Quick start', 'hub')).toEqual({ kind: 'missing' });
    expect(getWikiResolveResult(WIKI_ID, 'Quick start', 'local')).toBeUndefined();
  });
});
