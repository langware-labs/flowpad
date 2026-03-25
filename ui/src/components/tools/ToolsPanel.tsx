import { CompletionOptions, FlowMode, IChatOptionsValues } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Label } from '@src/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Separator } from '@src/components/ui/separator';
import { Switch } from '@src/components/ui/switch';
import { Globe, RotateCcw, Zap } from 'lucide-react';
import React from 'react';

interface ToolsPanelProps {
  value: IChatOptionsValues;
  onChange: (values: IChatOptionsValues) => void;
  disabled?: boolean;
  onClose?: () => void;
}

interface FlowModeOption {
  value: FlowMode;
  label: string;
  description: string;
}

const flowModeOptions: FlowModeOption[] = [
  {
    value: 'Ask' as FlowMode,
    label: 'Ask',
    description: 'Chat mode - Get answers without code execution',
  },
  {
    value: 'Agent' as FlowMode,
    label: 'Agent',
    description: 'Agent mode - AI executes code and performs actions',
  },
  {
    value: 'Auto' as FlowMode,
    label: 'Auto',
    description: 'Auto mode - AI decides when to execute code',
  },
];

const ToolsPanel: React.FC<ToolsPanelProps> = ({ value, onChange, disabled = false, onClose }) => {
  const flowMode = value.mode;
  const enableSearch = value.search;

  const currentFlowMode = flowModeOptions.find((opt) => opt.value === flowMode);
  const flowModeDisplay = currentFlowMode?.label || flowMode;

  const handleFlowModeChange = (mode: FlowMode) => {
    onChange({ ...value, mode });
  };

  const handleSearchChange = (enabled: boolean) => {
    onChange({ ...value, search: enabled });
  };

  const handleReset = () => {
    onChange(CompletionOptions.createDefaultValues());
  };

  return (
    <div className="space-y-4">
      {/* Flow Mode Section */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-muted-foreground" />
          <Label className="text-sm font-medium">Execution Mode</Label>
        </div>
        <Select value={flowMode} onValueChange={handleFlowModeChange} disabled={disabled}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select mode">{flowModeDisplay}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {flowModeOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <div className="flex flex-col gap-1">
                  <div className="font-medium">{option.label}</div>
                  <div className="text-xs text-muted-foreground">{option.description}</div>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Separator />

      {/* Tools Section */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <Label className="text-sm font-medium">Additional Tools</Label>
        </div>
        <div className="flex items-center justify-between rounded-md border p-3">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <div className="space-y-0.5">
              <Label htmlFor="web-search" className="text-sm font-medium">
                Web Search
              </Label>
              <p className="text-xs text-muted-foreground">Allow AI to search the web</p>
            </div>
          </div>
          <Switch id="web-search" checked={enableSearch} onCheckedChange={handleSearchChange} disabled={disabled} />
        </div>
      </div>

      {/* Action buttons at bottom */}
      <div className="flex gap-2 pt-2">
        <Button variant="outline" size="sm" onClick={handleReset} disabled={disabled} className="flex-1">
          <RotateCcw className="mr-2 h-3 w-3" />
          Reset
        </Button>
        {onClose && (
          <Button variant="default" size="sm" onClick={onClose} disabled={disabled} className="flex-1">
            Done
          </Button>
        )}
      </div>
    </div>
  );
};

export default ToolsPanel;
