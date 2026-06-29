import { useCallback } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useAMDEditor } from '../../AMDEditorContext';
import { AMDElement } from '../../types';

interface EachBlockProps {
  element: AMDElement;
}

export function EachBlock({ element }: EachBlockProps) {
  const { t } = useLingui();
  const { updateElement } = useAMDEditor();
  const el = element.element;

  const handleItemsChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateElement(element.localId, { attributes: { ...el.attributes, items: e.target.value } });
    },
    [element.localId, el.attributes, updateElement],
  );

  const handleAsChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateElement(element.localId, { attributes: { ...el.attributes, as: e.target.value } });
    },
    [element.localId, el.attributes, updateElement],
  );

  return (
    <div className="flex items-center gap-1.5 font-mono text-sm">
      <span className="text-muted-foreground"><Trans>for</Trans></span>
      <input
        value={el.as || ''}
        onChange={handleAsChange}
        placeholder={t`item`}
        className="w-20 border-0 border-b border-transparent bg-transparent px-0 py-0.5 outline-none focus:border-primary/50"
      />
      <span className="text-muted-foreground"><Trans>in</Trans></span>
      <input
        value={el.items || ''}
        onChange={handleItemsChange}
        placeholder={t`$items`}
        className="min-w-0 flex-1 border-0 border-b border-transparent bg-transparent px-0 py-0.5 outline-none focus:border-primary/50"
      />
    </div>
  );
}
