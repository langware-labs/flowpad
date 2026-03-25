import { useCallback } from 'react';
import { useAMDEditor } from '../../AMDEditorContext';
import { AMDElement } from '../../types';

interface BlockBlockProps {
  element: AMDElement;
}

export function BlockBlock({ element }: BlockBlockProps) {
  const { updateElement } = useAMDEditor();
  const el = element.element;

  const handleAgenticChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newAttrs = { ...el.attributes };
      if (!e.target.checked) {
        newAttrs['agentic'] = 'false';
      } else {
        delete newAttrs['agentic'];
      }
      updateElement(element.localId, { attributes: newAttrs });
    },
    [element.localId, el.attributes, updateElement],
  );

  const isAgentic = el.agentic;

  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
      <input
        type="checkbox"
        checked={isAgentic}
        onChange={handleAgenticChange}
        className="h-3.5 w-3.5 rounded border-muted-foreground/30"
      />
      <span>agentic</span>
    </label>
  );
}
