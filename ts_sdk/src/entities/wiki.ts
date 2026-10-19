import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import apiClient from '../client';
import type { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { TypeId } from '../models/TypeId';
import { isHubOnly } from '../utils/hub-runtime';

export type WikiResolveResult =
  | {
      kind: 'resolved';
      target_typeid: TypeId;
      source: 'entry' | 'implicit';
    }
  | { kind: 'missing' }
  | { kind: 'ambiguous' };

type TypeIdWire = TypeId | string | { type: string; id: string };

function typeIdFromWire(value: TypeIdWire): TypeId {
  if (value instanceof TypeId) return value;
  if (typeof value === 'string') return new TypeId(value);
  return new TypeId(value.type, value.id);
}

function resolveResultFromWire(value: unknown): WikiResolveResult {
  const result = value as {
    kind?: unknown;
    target_typeid?: TypeIdWire;
    source?: unknown;
  } | null;
  if (result?.kind === 'missing' || result?.kind === 'ambiguous') {
    return { kind: result.kind };
  }
  if (
    result?.kind === 'resolved'
    && result.target_typeid
    && (result.source === 'entry' || result.source === 'implicit')
  ) {
    return {
      kind: 'resolved',
      target_typeid: typeIdFromWire(result.target_typeid),
      source: result.source,
    };
  }
  throw new Error('Invalid Wiki resolve response');
}

@registerEntity
export class Wiki extends APIEntity<Wiki> {
  static type: string = 'wiki';

  static async resolveHub(wikiRef: string, word: string): Promise<WikiResolveResult> {
    // The shared UI has two Hub-authority deployments:
    //   desktop -> local server -> Hub (the explicit cloud bridge), and
    //   Hub UI  -> Hub API directly (the canonical graph action).
    // Keep that transport choice in the SDK so the DockPointer/view stays
    // identical in both deployments.
    if (isHubOnly()) {
      const action = new ActionInfo('resolve', Wiki.type, wikiRef, 'GET');
      action.queryParameters = { word };
      const result = await dataManager.callAction<void, unknown>(action);
      return resolveResultFromWire(result);
    }

    const result = await apiClient.get<unknown>(
      `/cloud/wiki/${encodeURIComponent(wikiRef)}/resolve`,
      { params: { word } },
    );
    return resolveResultFromWire(result);
  }

  async resolve(word: string): Promise<WikiResolveResult> {
    const action = new ActionInfo('resolve', Wiki.type, this.id, 'GET');
    action.queryParameters = { word };
    const result = await dataManager.callAction<void, unknown>(action);
    return resolveResultFromWire(result);
  }

  async bind(word: string, target: TypeId): Promise<WikiEntry> {
    const result = await this.post<IEntity>('bind', { word, target_typeid: target.toString() });
    return dataManager.updateEntityFromJson<WikiEntry>(result);
  }

  async unbind(word: string): Promise<void> {
    const action = new ActionInfo('unbind', Wiki.type, this.id, 'DELETE');
    action.queryParameters = { word };
    await dataManager.callAction<void, unknown>(action);
  }
}

interface WikiEntryWire extends Partial<IEntity> {
  word?: string;
  target_typeid?: TypeIdWire;
}

@registerEntity
export class WikiEntry extends APIEntity<WikiEntry> {
  static type: string = 'wiki_entry';

  word: string = '';
  target_typeid!: TypeId;

  constructor(entity: WikiEntryWire = {}) {
    super(entity);
    this.word = entity.word ?? '';
    if (entity.target_typeid) {
      this.target_typeid = typeIdFromWire(entity.target_typeid);
    }
  }
}
