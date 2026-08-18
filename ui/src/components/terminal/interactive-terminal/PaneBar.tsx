import { X } from 'lucide-react';
import React from 'react';
import { useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { ROW } from './InteractiveTabHeader';

export interface PaneBarProps {
  label: string;
  onClose: () => void;
}

export const PaneBar: React.FC<PaneBarProps> = ({ label, onClose }) => {
  const { t } = useLingui();

  return (
    <div className={ROW}>
      <span className="text-sm">{label}</span>
      <Button variant="ghost" size="sm" className="ms-auto h-6 w-6 p-0" onClick={onClose} title={t`Close`}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
};
