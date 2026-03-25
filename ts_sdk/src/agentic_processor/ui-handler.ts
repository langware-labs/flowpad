import { FlowData } from '../flow_processing';
import { UIComponentPayload } from './agentic-processor';

/**
 * Parsed UI Component from FlowData
 */
export interface UIComponent {
  id: string;
  uri?: string;
  page?: string;
  params: Record<string, unknown>;
  schema?: Record<string, unknown>;
  blocking: boolean;
  content?: string;
  flowData: FlowData;
}

/**
 * UI Handler - Processes FlowData with element-type="ui" into UIComponent objects
 */
export class UIHandler {
  private components: UIComponent[] = [];

  /**
   * Handle a FlowData element and extract UI component if applicable
   *
   * @param flowData - The FlowData element to process
   * @returns UIComponent if this is a UI element, null otherwise
   */
  public handleFlowData(flowData: FlowData): UIComponent | null {
    const elementType = flowData.attributes['element-type'];

    if (elementType !== 'ui') {
      return null;
    }

    const payload = flowData.data as UIComponentPayload;
    if (!payload) {
      return null;
    }

    const component: UIComponent = {
      id: payload.ui_id || flowData.attributes['ui-id'] || `ui_${flowData.index}`,
      uri: payload.uri,
      page: payload.page,
      params: payload.params || {},
      schema: payload.schema,
      blocking: payload.blocking ?? true,
      content: payload.content,
      flowData,
    };

    this.components.push(component);
    return component;
  }

  /**
   * Get all processed UI components
   */
  public getComponents(): readonly UIComponent[] {
    return [...this.components];
  }

  /**
   * Get blocking UI components
   */
  public getBlockingComponents(): UIComponent[] {
    return this.components.filter((c) => c.blocking);
  }

  /**
   * Get non-blocking UI components
   */
  public getNonBlockingComponents(): UIComponent[] {
    return this.components.filter((c) => !c.blocking);
  }

  /**
   * Get a UI component by ID
   */
  public getComponentById(id: string): UIComponent | undefined {
    return this.components.find((c) => c.id === id);
  }

  /**
   * Clear all processed components
   */
  public clear(): void {
    this.components = [];
  }

  /**
   * Get count of processed components
   */
  public get count(): number {
    return this.components.length;
  }
}

/**
 * Utility function to check if FlowData is a UI element
 */
export function isUIFlowData(flowData: FlowData): boolean {
  return flowData.attributes['element-type'] === 'ui';
}

/**
 * Utility function to extract UI payload from FlowData
 */
export function extractUIPayload(flowData: FlowData): UIComponentPayload | null {
  if (!isUIFlowData(flowData)) {
    return null;
  }
  return flowData.data as UIComponentPayload;
}
