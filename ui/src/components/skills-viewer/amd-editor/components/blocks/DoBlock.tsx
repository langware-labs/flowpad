import { Textarea } from '@src/components/ui/textarea';
import { useCallback, useEffect, useRef } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useAMDEditor } from '../../AMDEditorContext';
import { AMDElement } from '../../types';

interface DoBlockProps {
  element: AMDElement;
}

export function DoBlock({ element }: DoBlockProps) {
  const { t } = useLingui();
  const { updateElement } = useAMDEditor();
  const el = element.element;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea to fit content
  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      // Reset height to auto to get accurate scrollHeight
      textarea.style.height = 'auto';
      // Set height to scrollHeight to fit content
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, []);

  // Adjust height on content change
  useEffect(() => {
    adjustHeight();
  }, [el.content, adjustHeight]);

  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateElement(element.localId, { content: e.target.value });
      // Adjust height immediately for smooth expansion
      adjustHeight();
    },
    [element.localId, updateElement, adjustHeight],
  );

  return (
    <Textarea
      ref={textareaRef}
      value={el.content}
      onChange={handleContentChange}
      placeholder={t`Enter instructions...`}
      className="min-h-[40px] resize-none overflow-hidden border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
    />
  );
}
