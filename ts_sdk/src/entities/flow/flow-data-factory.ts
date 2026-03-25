import { FlowData } from '../../flow_processing/flow-data';
import { FlowElementTypes, isFlowElementType, normalizeElementType } from '../../flow_processing/flow-element-types';
import { StateFlowData } from './flow-data-types/state-message';

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
    const normalizedTagName: string = normalizeElementType(xmlTagName);
    if (!isFlowElementType(xmlTagName)) {
      console.warn(
        `[FlowDataFactory.fromElementType] Unknown element type: "${xmlTagName}". Expected one of: ${Object.values(FlowElementTypes).join(', ')}`,
      );
    }

    // Strip 'flow-' prefix if present to normalize tag name for switch matching
    // But pass original tagName to FlowData constructor to preserve exact XML tag

    let flowData: FlowData;

    switch (normalizedTagName) {
      case FlowElementTypes.SHELL_INPUT:
      case FlowElementTypes.SHELL_OUTPUT:
      case FlowElementTypes.USER_MESSAGE:
      case FlowElementTypes.FOCUS:
        // Server sends these elements with all attributes in XML
        // Specialized constructors create default attributes which would override XML values
        // For server XML parsing, use plain FlowData to preserve all attributes
        // Pass original tagName (not normalized) to match XML closing tags exactly
        flowData = new FlowData(xmlTagName, data, attributes);
        break;
      case FlowElementTypes.STATE:
        flowData = new StateFlowData(xmlTagName, data, attributes);
        break;
      default:
        // Default to plain FlowData for all other types
        // Pass original tagName (not normalized) to match XML closing tags exactly
        flowData = new FlowData(xmlTagName, data, attributes);
    }

    if (parseData) {
      flowData.parseElementData();
    }

    return flowData;
  }
}
