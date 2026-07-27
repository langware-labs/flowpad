import { FlowData } from './flow-data';
import { FlowElementTypes, isFlowElementType } from './flow-element-types';

/**
 * Factory for creating FlowData instances from element type
 * This sits above the class hierarchy to avoid circular dependencies
 */
export class FlowDataFactory {
  /**
   * Create a FlowData instance from an element type
   * Returns specialized classes where appropriate (ShellCmdFlowData, etc.)
   * or generic FlowData for unknown types
   */
  static fromElementType(
    xmlTagName: string,
    data: any,
    attributes: Record<string, string> = {},
    parseData: boolean = false,
  ): FlowData {
    // Validate element type and warn if unknown
    if (!isFlowElementType(xmlTagName)) {
      console.warn(
        `[FlowDataFactory.fromElementType] Unknown element type: "${xmlTagName}". Expected one of: ${Object.values(FlowElementTypes).join(', ')}`,
      );
    }

    // Pass original tagName (not normalized) to match XML closing tags exactly;
    // the server sends all attributes in XML, so plain FlowData preserves them.
    const flowData = new FlowData(xmlTagName, data, attributes);

    if (parseData) {
      flowData.parseElementData();
    }

    return flowData;
  }
}
