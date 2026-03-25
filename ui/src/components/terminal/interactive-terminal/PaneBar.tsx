import { X } from 'lucide-react';
import React from 'react';
import { Button } from '@src/components/ui/button';

export interface PaneBarProps {
  label: string;
  onClose: () => void;
}

export const PaneBar: React.FC<PaneBarProps> = ({ label, onClose }) => {
  return (
    <div className="flex items-center gap-0.5 border-b bg-muted/30 px-2 py-1">
      <span className="text-sm">{label}</span>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto h-6 w-6 p-0"
        onClick={onClose}
        title="Close"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
};
