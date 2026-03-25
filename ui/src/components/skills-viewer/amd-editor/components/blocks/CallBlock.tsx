import { useCallback } from 'react';
import { useAMDEditor } from '../../AMDEditorContext';
import { AMDElement } from '../../types';

interface CallBlockProps {
  element: AMDElement;
}

export function CallBlock({ element }: CallBlockProps) {
  const { updateElement } = useAMDEditor();
  const el = element.element;

  const handleHrefChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateElement(element.localId, { attributes: { ...el.attributes, href: e.target.value } });
    },
    [element.localId, el.attributes, updateElement],
  );

  return (
    <input
      value={el.href || ''}
      onChange={handleHrefChange}
      placeholder="./path/to/file.md"
      className="w-full border-0 border-b border-transparent bg-transparent px-0 py-0.5 font-mono text-sm text-foreground outline-none focus:border-primary/50"
    />
  );
}
