import React, { useState } from 'react';
import { X } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';

interface Props {
  tags: string[];
  onTagsChange: (tags: string[]) => void;
}

export function TagFilterBar({ tags, onTagsChange }: Props) {
  const { t } = useLingui();
  const [input, setInput] = useState('');

  const addTag = (tag: string) => {
    const t = tag.trim();
    if (t && !tags.includes(t)) onTagsChange([...tags, t]);
    setInput('');
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <span key={tag} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
          {tag}
          <button
            onClick={() => onTagsChange(tags.filter((t) => t !== tag))}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addTag(input);
          }
        }}
        placeholder={t`Add tag…`}
        className="h-6 min-w-[80px] rounded border-none bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
