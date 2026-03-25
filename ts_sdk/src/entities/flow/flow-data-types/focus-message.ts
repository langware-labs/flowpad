import { JsonFlowData } from './primitives';
import { FlowDataAttribute } from '../../../flow_processing/flow-data';
import { FlowElementTypes } from '../../../flow_processing/flow-element-types';

/**
 * Focus message data structure for flow-focus events
 */
export interface FocusMessageData {
  content: string;
}

/**
 * Specialized FlowData for focus messages
 */
export class FocusMessageFlowData extends JsonFlowData<FocusMessageData> {
  constructor(index: number = 0, focusType: string = 'reasoning') {
    const data: FocusMessageData = {
      content: '',
    };

    super(FlowElementTypes.FOCUS, data, {
      [FlowDataAttribute.INDEX]: index.toString(),
      [FlowDataAttribute.FOCUS_TYPE]: focusType,
    });
  }
}
