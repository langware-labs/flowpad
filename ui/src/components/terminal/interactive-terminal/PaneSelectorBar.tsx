import { Bot, SquareTerminal } from 'lucide-react';
import React from 'react';
import { Button } from '@src/components/ui/button';

export interface PaneSelectorBarProps {
  activePane: 'claude' | 'shell';
  onSelect: (pane: 'claude' | 'shell') => void;
}

export const PaneSelectorBar: React.FC<PaneSelectorBarProps> = ({ activePane, onSelect }) => {
  return (
    <div className="flex flex-col items-center gap-2 border-r bg-muted/30 px-1 py-2">
      <Button
        variant={activePane === 'claude' ? 'secondary' : 'ghost'}
        size="icon"
        className={`h-10 w-10 ${activePane === 'claude' ? 'ring-2 ring-primary' : ''}`}
        onClick={() => onSelect('claude')}
        title="Claude"
      >
        <Bot className="h-5 w-5" />
      </Button>
      <Button
        variant={activePane === 'shell' ? 'secondary' : 'ghost'}
        size="icon"
        className={`h-10 w-10 ${activePane === 'shell' ? 'ring-2 ring-primary' : ''}`}
        onClick={() => onSelect('shell')}
        title="Shell"
      >
        <SquareTerminal className="h-5 w-5" />
      </Button>
    </div>
  );
};
