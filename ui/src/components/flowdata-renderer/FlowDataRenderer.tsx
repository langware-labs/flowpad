import { enhanceFlowData } from '@src/types/ui-flowdata';
import { FlowData } from '@sdk';
import { UserMessageComponent } from './UserMessageComponent';
import { TextMessageComponent } from './TextMessageComponent';
import { ReasoningMessageComponent } from './ReasoningMessageComponent';
import { ShellMessageComponent } from './ShellMessageComponent';
import { ResultMessageComponent } from './ResultMessageComponent';
import { SecretMessageComponent } from './SecretMessageComponent';
import { CheckpointMessageComponent } from './CheckpointMessageComponent';
import { StatusMessageComponent } from './StatusMessageComponent';
import { WriteMessageComponent } from './WriteMessageComponent';
import { ToolCallMessageComponent } from './ToolCallMessageComponent';
import { ToolResultMessageComponent } from './ToolResultMessageComponent';
import { UnknownMessageComponent } from './UnknownMessageComponent';

interface FlowDataRendererProps {
  flowData: FlowData;
  className?: string;
}

/**
 * Main FlowData renderer - routes to appropriate component based on elementType
 */
export function FlowDataRenderer({ flowData, className = '' }: FlowDataRendererProps) {
  const uiFlowData = enhanceFlowData(flowData);

  const getComponent = () => {
    switch (uiFlowData.componentType) {
      case 'UserMessage':
        return <UserMessageComponent flowData={uiFlowData} />;
      case 'TextMessage':
        return <TextMessageComponent flowData={uiFlowData} />;
      case 'ReasoningMessage':
        return <ReasoningMessageComponent flowData={uiFlowData} />;
      case 'ShellMessage':
        return <ShellMessageComponent flowData={uiFlowData} />;
      case 'ResultMessage':
        return <ResultMessageComponent flowData={uiFlowData} />;
      case 'SecretMessage':
        return <SecretMessageComponent flowData={uiFlowData} />;
      case 'CheckpointMessage':
        return <CheckpointMessageComponent flowData={uiFlowData} />;
      case 'StatusMessage':
        return <StatusMessageComponent flowData={uiFlowData} />;
      case 'WriteMessage':
        return <WriteMessageComponent flowData={uiFlowData} />;
      case 'ToolCallMessage':
        return <ToolCallMessageComponent flowData={uiFlowData} />;
      case 'ToolResultMessage':
        return <ToolResultMessageComponent flowData={uiFlowData} />;
      default:
        return <UnknownMessageComponent flowData={uiFlowData} />;
    }
  };

  return (
    <div
      className={`flowdata-message ${uiFlowData.displayRole} ${uiFlowData.elementType} ${className}`}
      data-message-type={uiFlowData.elementType}
      data-role={uiFlowData.displayRole}
      data-source={uiFlowData.messageSource}
    >
      {getComponent()}
    </div>
  );
}

export default FlowDataRenderer;
