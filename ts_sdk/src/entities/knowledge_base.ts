import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { ActionInfo } from '../models';
import { TypeId } from '../models/TypeId';

@registerEntity
export class KnowledgeBase extends APIEntity<KnowledgeBase> {
  static type: string = 'knowledge_base';
  raw_knowledge?: string;
  name?: string;

  constructor(entity: Partial<KnowledgeBase> = {}) {
    super(entity);
    this.raw_knowledge = entity.raw_knowledge;
  }

  async download() {
    try {
      const actionInfo = new ActionInfo('download', this.getType(), this.id, 'GET', true, false, null, 'blob');
      const response = await dataManager.callAction<void, Blob>(actionInfo);
      console.log('download response', response);
      return response;
    } catch (e) {
      console.error('Failed to download knowledge base: ', e);
      throw e;
    }
  }

  static async upload(knowledge_file: File, scope: TypeId[]) {
    try {
      if (!knowledge_file) {
        throw new Error('knowledge_file is required and cannot be empty');
      }

      const actionInfo = new ActionInfo('upload', KnowledgeBase.type, '', 'POST');
      actionInfo.scope = scope;
      const formData = new FormData();
      formData.append('knowledge_file', knowledge_file);
      actionInfo.bodyParameters = formData;

      const response = await dataManager.callAction<FormData, string>(actionInfo);
      return response;
    } catch (e) {
      console.error('Failed to upload knowledge base: ', e);
      throw e;
    }
  }
}
