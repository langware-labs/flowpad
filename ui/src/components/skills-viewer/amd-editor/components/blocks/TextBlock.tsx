import { useCallback } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useAMDEditor } from '../../AMDEditorContext';
import { AMDElement } from '../../types';

interface TextBlockProps {
  element: AMDElement;
}

export function TextBlock({ element }: TextBlockProps) {
  const { t } = useLingui();
  const { updateElement } = useAMDEditor();
  const el = element.element;

  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateElement(element.localId, { content: e.target.value });
    },
    [element.localId, updateElement],
  );

  return (
    <textarea
      value={el.content}
      onChange={handleContentChange}
      placeholder={t`Markdown text...`}
      className="min-h-[40px] w-full resize-y border-0 bg-transparent p-0 text-sm outline-none focus:ring-0"
    />
  );
}
