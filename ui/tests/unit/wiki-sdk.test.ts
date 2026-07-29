import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dataManager,
  Markdown,
  Project,
  setSupportedPagesForHubMode,
  TypeId,
  Wiki,
  WikiEntry,
} from '@sdk';
import type { ActionInfo } from '@sdk';
import apiClient from '@sdk/client';

const PROJECT_ID = '4f905b7b-6873-4a43-bb19-27c8216ed4bd';
const WIKI_ID = 'f5a5ec65-13f8-4dbd-bca5-6cdba46cf39f';
const TARGET_ID = '261d63fd-4655-4ab6-84bc-3f8b966c7f0e';
const ENTRY_ID = '3ed50c86-df6c-41ec-888b-529d9ae9b73d';

afterEach(() => {
  vi.restoreAllMocks();
  setSupportedPagesForHubMode(['desk']);
  dataManager.removeEntityFromCache(new TypeId(Project.type, PROJECT_ID));
  dataManager.removeEntityFromCache(new TypeId(Wiki.type, WIKI_ID));
  dataManager.removeEntityFromCache(new TypeId(WikiEntry.type, ENTRY_ID));
});

describe('Wiki SDK graph actions', () => {
  it('resolves a Hub Wiki through the canonical graph action in direct-Hub mode', async () => {
    setSupportedPagesForHubMode(['hub']);
    const graphCall = vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      kind: 'resolved',
      target_typeid: `markdown-${TARGET_ID}`,
      source: 'implicit',
    } as never);
    const cloudCall = vi.spyOn(apiClient, 'get');

    const result = await Wiki.resolveHub(WIKI_ID, 'Quick start');

    const action = graphCall.mock.calls[0][0] as ActionInfo;
    expect(action.actionUrl).toBe(
      `/graph/wiki/${WIKI_ID}/resolve?word=Quick+start`,
    );
    expect(cloudCall).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: 'resolved',
      target_typeid: new TypeId('markdown', TARGET_ID),
      source: 'implicit',
    });
  });

  it('uses the local-server cloud bridge for a Hub Wiki opened from desktop mode', async () => {
    setSupportedPagesForHubMode(['desk']);
    const graphCall = vi.spyOn(dataManager, 'callAction');
    const cloudCall = vi.spyOn(apiClient, 'get').mockResolvedValue({
      kind: 'missing',
    });

    const result = await Wiki.resolveHub(WIKI_ID, 'Not there');

    expect(graphCall).not.toHaveBeenCalled();
    expect(cloudCall).toHaveBeenCalledWith(
      `/cloud/wiki/${WIKI_ID}/resolve`,
      { params: { word: 'Not there' } },
    );
    expect(result).toEqual({ kind: 'missing' });
  });

  it('resolves through graph/wiki/<ref>/resolve and hydrates the target TypeId', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      kind: 'resolved',
      target_typeid: `markdown-${TARGET_ID}`,
      source: 'entry',
    } as never);

    const result = await new Wiki({ id: WIKI_ID }).resolve('Quick start');

    const action = call.mock.calls[0][0] as ActionInfo;
    expect(action.actionUrl).toBe(
      `/graph/wiki/${WIKI_ID}/resolve?word=Quick+start`,
    );
    expect(result).toEqual({
      kind: 'resolved',
      target_typeid: new TypeId('markdown', TARGET_ID),
      source: 'entry',
    });
  });

  it('binds and unbinds without creating a target relationship in the SDK', async () => {
    const call = vi.spyOn(dataManager, 'callAction')
      .mockResolvedValueOnce({
        id: ENTRY_ID,
        type: WikiEntry.type,
        word: 'Quick start',
        target_typeid: `skill-${TARGET_ID}`,
      } as never)
      .mockResolvedValueOnce(undefined as never);
    const wiki = new Wiki({ id: WIKI_ID });
    const target = new TypeId('skill', TARGET_ID);

    const entry = await wiki.bind('Quick start', target);
    await wiki.unbind('Quick start');

    expect(entry).toBeInstanceOf(WikiEntry);
    expect(entry.target_typeid.equals(target)).toBe(true);
    expect((call.mock.calls[0][0] as ActionInfo).actionUrl).toBe(
      `/graph/wiki/${WIKI_ID}/bind`,
    );
    expect((call.mock.calls[0][0] as ActionInfo).bodyParameters).toEqual({
      word: 'Quick start',
      target_typeid: target.toString(),
    });
    expect((call.mock.calls[1][0] as ActionInfo).actionUrl).toBe(
      `/graph/wiki/${WIKI_ID}/unbind?word=Quick+start`,
    );
  });

  it('loads a Project default Wiki as a registered SDK entity', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      id: WIKI_ID,
      type: Wiki.type,
      name: 'Default Wiki',
    } as never);

    const wiki = await new Project({ id: PROJECT_ID }).getDefaultWiki();

    expect(wiki).toBeInstanceOf(Wiki);
    expect((call.mock.calls[0][0] as ActionInfo).actionUrl).toBe(
      `/graph/project/${PROJECT_ID}/default-wiki`,
    );
  });

  it('opts record refs into Hub reflection only when the caller selects Hub authority', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      record_folder_ref: null,
      main_ref: null,
    } as never);
    const entity = new Markdown({ id: TARGET_ID });

    await entity.record({ hubReflect: true });

    const action = call.mock.calls[0][0] as ActionInfo;
    expect(action.actionUrl).toBe(`/graph/markdown/${TARGET_ID}/record/refs`);
    expect(action.hubReflect).toBe(true);
  });
});
