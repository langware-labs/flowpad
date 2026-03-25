import { FlowData, FlowDataType, FlowDataAttribute } from '../../../flow_processing/flow-data';

/**
 * Base class for text-based FlowData elements
 */
export abstract class TextFlowData<T = { content: string }> extends FlowData<T> {
  constructor(tagName: string, data: T | string, attributes: Record<string, string> = {}) {
    const textAttributes = {
      ...attributes,
      [FlowDataAttribute.DATA_TYPE]: FlowDataType.String,
    };

    // Convert data to raw string content
    let rawContent: string;
    if (typeof data === 'string') {
      rawContent = data;
    } else if (typeof data === 'object' && data !== null && 'content' in data) {
      rawContent = (data as any).content || '';
    } else {
      rawContent = String(data);
    }

    super(tagName, rawContent, textAttributes);
  }
}

/**
 * Base class for JSON/Object-based FlowData elements
 */
export abstract class JsonFlowData<T extends object = any> extends FlowData<T> {
  constructor(tagName: string, data: T, attributes: Record<string, string> = {}) {
    const jsonAttributes = {
      ...attributes,
      [FlowDataAttribute.DATA_TYPE]: FlowDataType.Object,
    };

    // Convert data to raw JSON string
    const rawContent = JSON.stringify(data);

    super(tagName, rawContent, jsonAttributes);
  }
}

/**
 * Base class for Entity-based FlowData elements
 */
export abstract class EntityFlowData<T = any> extends FlowData<T> {
  constructor(tagName: string, data: T, attributes: Record<string, string> = {}) {
    const entityAttributes = {
      ...attributes,
      [FlowDataAttribute.DATA_TYPE]: FlowDataType.Entity,
    };

    // Convert data to raw JSON string
    const rawContent = JSON.stringify(data);

    super(tagName, rawContent, entityAttributes);
  }
}
