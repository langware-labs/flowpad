import { FlowStateProperty, IFlowState } from '../flow-types';
import { FlowDataAttribute } from '../../../flow_processing/flow-data';
import { JsonFlowData } from './primitives';

/**
 * Specialized FlowData for focus messages
 */
export class StateFlowData extends JsonFlowData<IFlowState> {
  constructor(xmlTagName: string, data: any, attributes: Record<string, string> = {}) {
    super(xmlTagName, data, attributes);
  }

  get key(): FlowStateProperty | null {
    const rawKey = this.attributes[FlowDataAttribute.KEY];

    if (typeof rawKey !== 'string' || rawKey.trim().length === 0) {
      console.warn('[StateFlowData] state message missing key attribute', this.attributes);
      return null;
    }

    return rawKey as FlowStateProperty;
  }
}
