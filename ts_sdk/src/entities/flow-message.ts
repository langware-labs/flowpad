import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';

export interface IFlowMessage extends IEntity {
  text?: string;
  instruction?: string | null;
  context?: Array<{ type: string; id: string }>;
  attachment?: Array<{ type: string; id: string }>;
  sender_id?: string | null;
  sender_name?: string | null;
  receiver_address?: string | null;
  receiver_address_type?: string | null;
}

@registerEntity
export class FlowMessage extends APIEntity<FlowMessage> implements IFlowMessage {
  text?: string;
  instruction?: string | null;
  context?: Array<{ type: string; id: string }>;
  attachment?: Array<{ type: string; id: string }>;
  sender_id?: string | null;
  sender_name?: string | null;
  receiver_address?: string | null;
  receiver_address_type?: string | null;
  static type: string = 'flow_message';

  constructor(entity: Partial<IFlowMessage> = {}) {
    super(entity);
    this.text = entity.text;
    this.instruction = entity.instruction;
    this.context = entity.context;
    this.attachment = entity.attachment;
    this.sender_id = entity.sender_id;
    this.sender_name = entity.sender_name;
    this.receiver_address = entity.receiver_address;
    this.receiver_address_type = entity.receiver_address_type;
  }
}

export interface UploadFlowMessageResult {
  message_id: string;
  task_id: string | null;
  conversation_id: string | null;
  was_new_task: boolean;
}

export interface UploadConflict {
  type: string;
  id: string;
}

export async function uploadFlowMessage(
  file: File,
  options: { overwrite?: boolean } = {},
): Promise<UploadFlowMessageResult> {
  const formData = new FormData();
  formData.append('file', file);
  if (options.overwrite) formData.append('overwrite', 'true');

  const action = new ActionInfo('file-upload', 'flow_message', null, 'POST');
  action.bodyParameters = formData;
  const res = await dataManager.callAction<FormData, UploadFlowMessageResult>(action);
  return res!;
}

export function downloadFlowMessageUrl(messageId: string): string {
  const action = new ActionInfo('file-download', 'flow_message', messageId, 'GET');
  return action.fullActionUrl;
}

export interface CreateTaskBundleParams {
  spec_title: string;
  spec_content?: string;
  task_title?: string;
  message?: string | null;
  team_space_id?: string | null;
}

export interface CreateTaskBundleResult {
  flow_message_id: string;
  task_id: string;
  conversation_id: string;
  spec_id: string;
}

export async function createTaskBundle(params: CreateTaskBundleParams): Promise<CreateTaskBundleResult> {
  const action = new ActionInfo('flow-message-create', null, null, 'POST');
  action.bodyParameters = params;
  const res = await dataManager.callAction<CreateTaskBundleParams, CreateTaskBundleResult>(action);
  return res!;
}
