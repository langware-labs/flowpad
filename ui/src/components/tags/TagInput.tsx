import { useState } from 'react';
import { X } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { Command as CommandPrimitive } from 'cmdk';
import apiClient from '@sdk/client';
import { toTag } from '@sdk/tags/grammar';
import { Command, CommandItem, CommandList } from '@src/components/ui/command';

const MAX_SUGGESTIONS = 8;

/**
 * Tags as chips, plus a field that adds one. What is typed is converted to a
 * valid tag (`Meeting Notes` → `meeting-notes`) and offered first, ahead of the
 * names already in use; Enter takes the highlighted row, `,` takes what was typed.
 *
 * The suggestions sit INSIDE this element, not in a portal: a hover card that
 * holds this field closes when the pointer moves to anything portaled out of it.
 */
export function TagInput({
  tags,
  onAdd,
  onRemove,
}: {
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}) {
  const { t } = useLingui();
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
  /** Names in use, fetched the first time the field is focused. */
  const [names, setNames] = useState<string[] | null>(null);

  const loadNames = () => {
    if (names !== null) return;
    setNames([]);
    void apiClient
      .get<{ names?: string[] }>('/api/v1/tags/names')
      .then((data) => setNames(data?.names ?? []))
      .catch(() => undefined);
  };

  const add = (value: string) => {
    const tag = toTag(value);
    if (tag && !tags.includes(tag)) onAdd(tag);
    setInput('');
  };

  const typed = toTag(input);
  // Text with no tag in it offers nothing; an empty field offers every name in use.
  const matching = input.trim() && !typed ? [] : (names ?? []).filter((name) => name.includes(typed ?? ''));
  const offered = [typed, ...matching.filter((name) => name !== typed)]
    .filter((name): name is string => !!name && !tags.includes(name))
    .slice(0, MAX_SUGGESTIONS);

  return (
    <Command shouldFilter={false} className="relative h-auto overflow-visible bg-transparent" data-testid="tag-input">
      <div className="flex flex-wrap items-center gap-1">
        {tags.map((tag) => (
          <span key={tag} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
            {tag}
            <button
              type="button"
              aria-label={t`Remove tag ${tag}`}
              onClick={() => onRemove(tag)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <CommandPrimitive.Input
          value={input}
          onValueChange={setInput}
          onFocus={() => {
            setFocused(true);
            loadNames();
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === ',') {
              e.preventDefault();
              add(input);
            } else if (e.key === 'Enter' && (!typed || tags.includes(typed))) {
              // No new tag typed: Enter must not take the first suggestion.
              e.preventDefault();
              setInput('');
            }
          }}
          placeholder={t`Add tag…`}
          className="h-6 min-w-[80px] flex-1 rounded border-none bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
      {focused && offered.length > 0 && (
        <CommandList className="absolute start-0 top-full z-50 mt-1 max-h-48 min-w-[160px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {offered.map((name) => (
            <CommandItem
              key={name}
              value={name}
              // Keep the field focused, so the list is still there when the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onSelect={() => add(name)}
              className="text-xs"
              data-testid={`tag-suggestion-${name}`}
            >
              {name}
            </CommandItem>
          ))}
        </CommandList>
      )}
    </Command>
  );
}
