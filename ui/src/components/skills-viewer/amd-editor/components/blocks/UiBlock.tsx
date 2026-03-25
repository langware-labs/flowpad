import { useCallback } from 'react';
import { useAMDEditor } from '../../AMDEditorContext';
import { AMDElement } from '../../types';

interface UiBlockProps {
  element: AMDElement;
}

export function UiBlock({ element }: UiBlockProps) {
  const { updateElement } = useAMDEditor();
  const el = element.element;

  const handleUriChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateElement(element.localId, { attributes: { ...el.attributes, uri: e.target.value } });
    },
    [element.localId, el.attributes, updateElement],
  );

  const handleNonBlockingChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newAttrs = { ...el.attributes };
      if (e.target.checked) {
        newAttrs['non-blocking'] = 'true';
      } else {
        delete newAttrs['non-blocking'];
      }
      updateElement(element.localId, { attributes: newAttrs });
    },
    [element.localId, el.attributes, updateElement],
  );

  const isNonBlocking = el.attributes['non-blocking'] === 'true';

  return (
    <div className="flex items-center gap-2">
      <input
        value={el.uri || ''}
        onChange={handleUriChange}
        placeholder="vfs://project/components/name"
        className="min-w-0 flex-1 border-0 border-b border-transparent bg-transparent px-0 py-0.5 font-mono text-sm text-foreground outline-none focus:border-primary/50"
      />
      <label className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={isNonBlocking}
          onChange={handleNonBlockingChange}
          className="h-3 w-3 rounded border-muted-foreground/30"
        />
        <span>async</span>
      </label>
    </div>
  );
}
