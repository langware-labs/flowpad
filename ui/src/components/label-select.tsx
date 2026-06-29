import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { LabelChipBlock } from './label-chip-block';

interface LabelSelectProps {
  selected: string[];
  available: string[];
  onToggle: (label: string) => void;
  onAdd: (label: string) => void;
  onRemove: (label: string) => void;
}

export function LabelSelect({ selected, available, onToggle, onAdd, onRemove }: LabelSelectProps) {
  const { t } = useLingui();
  const [inputValue, setInputValue] = useState('');

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      onAdd(inputValue.trim());
      setInputValue('');
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Label chips with expand/collapse functionality */}
      <LabelChipBlock labels={available} selected={selected} maxChips={3} onToggle={onToggle} onRemove={onRemove} />

      {/* Input field with fixed size */}
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t`Add custom label...`}
        className="w-full border-none bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
