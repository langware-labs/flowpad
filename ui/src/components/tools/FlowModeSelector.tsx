import { FlowMode } from '@sdk';
import { Zap } from 'lucide-react';
import React from 'react';
import OptionSelector, { SelectorOption } from './OptionSelector';

interface FlowModeSelectorProps {
  value: FlowMode;
  onChange: (mode: FlowMode) => void;
  disabled?: boolean;
  detectedMode?: FlowMode | null;
  className?: string;
}

// Define flow mode options with labels and tooltips
const flowModeOptions: SelectorOption<FlowMode>[] = [
  {
    value: 'Ask' as FlowMode,
    label: 'Ask',
    tooltip: 'Chat mode - Get answers without code execution',
  },
  {
    value: 'Agent' as FlowMode,
    label: 'Agent',
    tooltip: 'Agent mode - AI executes code and performs actions',
  },
  {
    value: 'Auto' as FlowMode,
    label: 'Auto',
    tooltip: 'Auto mode - AI decides when to execute code',
  },
];

const FlowModeSelector: React.FC<FlowModeSelectorProps> = ({
  value,
  onChange,
  disabled = false,
  detectedMode,
  className,
}) => {
  return (
    <OptionSelector
      value={value}
      options={flowModeOptions}
      onChange={onChange}
      disabled={disabled}
      triggerIcon={<Zap className="h-3 w-3" />}
      detectedValue={detectedMode}
      className={className}
      triggerTooltip="Select execution mode"
    />
  );
};

export default FlowModeSelector;
