import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@src/components/ui/dropdown-menu';
import { DropdownMenuLabel } from '@src/components/ui/dropdown-menu';
import { Trans } from '@lingui/react/macro';
import { InstructionElementType } from '@sdk';
import { Box, Code, FileText, GitBranch, MonitorPlay, Repeat, Settings, Type } from 'lucide-react';
import { BLOCK_CONFIGS, CREATABLE_BLOCK_TYPES } from '../types';

interface BlockPickerProps {
  onSelect: (type: InstructionElementType) => void;
  trigger: React.ReactNode;
}

const BLOCK_ICONS: Record<string, React.ReactNode> = {
  do: <Code className="h-4 w-4" />,
  if: <GitBranch className="h-4 w-4" />,
  each: <Repeat className="h-4 w-4" />,
  set: <Settings className="h-4 w-4" />,
  ui: <MonitorPlay className="h-4 w-4" />,
  block: <Box className="h-4 w-4" />,
  call: <FileText className="h-4 w-4" />,
  text: <Type className="h-4 w-4" />,
};

export function BlockPicker({ onSelect, trigger }: BlockPickerProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel><Trans>Add Block</Trans></DropdownMenuLabel>
        <DropdownMenuSeparator />

        {CREATABLE_BLOCK_TYPES.map((type) => {
          const config = BLOCK_CONFIGS[type];
          return (
            <DropdownMenuItem key={type} onClick={() => onSelect(type)} className="flex items-center gap-2">
              <span className={config.color.replace('border-', 'text-')}>{BLOCK_ICONS[type]}</span>
              <div className="flex flex-col">
                <span className="font-medium">{config.label}</span>
                <span className="text-xs text-muted-foreground">{config.description}</span>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
