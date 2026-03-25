import { TextFlowData } from './primitives';
import { FlowDataAttribute } from '../../../flow_processing/flow-data';
import { FlowElementTypes } from '../../../flow_processing/flow-element-types';

/**
 * User message data structure for flow-user-message events
 */
export interface UserMessageData {
  content: string;
}

/**
 * Specialized FlowData for user messages
 */
export class UserMessageFlowData extends TextFlowData<UserMessageData> {
  constructor(index: number = 0) {
    const data: UserMessageData = {
      content: '',
    };

    super(FlowElementTypes.USER_MESSAGE, data, {
      [FlowDataAttribute.INDEX]: index.toString(),
    });
  }
}
