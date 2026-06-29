import { useCallback } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useAMDEditor } from '../../AMDEditorContext';
import { AMDElement } from '../../types';

interface SetBlockProps {
  element: AMDElement;
}

export function SetBlock({ element }: SetBlockProps) {
  const { t } = useLingui();
  const { updateElement } = useAMDEditor();
  const el = element.element;

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateElement(element.localId, { attributes: { ...el.attributes, name: e.target.value } });
    },
    [element.localId, el.attributes, updateElement],
  );

  const handleValueChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateElement(element.localId, { attributes: { ...el.attributes, value: e.target.value } });
    },
    [element.localId, el.attributes, updateElement],
  );

  return (
    <div className="flex items-center gap-1.5 font-mono text-sm">
      <input
        value={el.name || ''}
        onChange={handleNameChange}
        placeholder={t`variable`}
        className="w-28 border-0 border-b border-transparent bg-transparent px-0 py-0.5 text-foreground outline-none focus:border-primary/50"
      />
      <span className="text-muted-foreground">=</span>
      <input
        value={el.value || ''}
        onChange={handleValueChange}
        placeholder={t`value`}
        className="min-w-0 flex-1 border-0 border-b border-transparent bg-transparent px-0 py-0.5 text-foreground outline-none focus:border-primary/50"
      />
    </div>
  );
}
