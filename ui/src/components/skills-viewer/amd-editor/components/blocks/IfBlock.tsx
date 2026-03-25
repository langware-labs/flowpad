import { useCallback } from 'react';
import { useAMDEditor } from '../../AMDEditorContext';
import { AMDElement } from '../../types';

interface IfBlockProps {
  element: AMDElement;
}

export function IfBlock({ element }: IfBlockProps) {
  const { updateElement } = useAMDEditor();
  const el = element.element;

  const handleTestChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateElement(element.localId, { attributes: { ...el.attributes, test: e.target.value } });
    },
    [element.localId, el.attributes, updateElement],
  );

  return (
    <input
      value={el.test || ''}
      onChange={handleTestChange}
      placeholder="$variable > 0"
      className="w-full border-0 border-b border-transparent bg-transparent px-0 py-0.5 font-mono text-sm text-foreground outline-none focus:border-primary/50"
    />
  );
}
