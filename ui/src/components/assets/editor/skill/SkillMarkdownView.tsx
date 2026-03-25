import { SkillMetadata, SkillParser } from '@sdk';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SkillMetadataHeader } from './SkillMetadataHeader';
import { MilkdownEditor } from '@src/components/milkdown-editor/MilkdownEditor';

interface SkillMarkdownViewProps {
  content: string;
  onChange?: (content: string) => void;
}

export function SkillMarkdownView({ content, onChange }: SkillMarkdownViewProps) {
  const [metadata, setMetadata] = useState<SkillMetadata | null>(() => {
    try {
      return SkillParser.parse(content).metadata;
    } catch {
      return null;
    }
  });
  const metadataRef = useRef<SkillMetadata | null>(metadata);
  const bodyRef = useRef<string>('');
  const lastEmittedRef = useRef<string | null>(null);

  // Parse content once — derive body for the editor, cache parsed metadata
  const parsed = useMemo(() => {
    try {
      const { metadata: m, content: body } = SkillParser.parse(content);
      return { metadata: m, body };
    } catch {
      return { metadata: null, body: content };
    }
  }, [content]);

  bodyRef.current = parsed.body;

  // Sync metadata only on external content changes (not our own emits).
  // Skipping internal changes avoids the parser's .trim() overwriting
  // the user's in-progress typing (e.g. trailing spaces in description).
  useEffect(() => {
    if (content === lastEmittedRef.current) return;
    setMetadata(parsed.metadata);
    metadataRef.current = parsed.metadata;
  }, [content, parsed.metadata]);

  // Serialize and emit. Stores what we emitted so we can recognize it later.
  const emit = useCallback(
    (meta: SkillMetadata | null, body: string) => {
      if (!onChange) return;
      const serialized = meta ? SkillParser.serialize(meta, body) : body;
      lastEmittedRef.current = serialized;
      onChange(serialized);
    },
    [onChange],
  );

  // Stable body change handler — uses refs to avoid recreating on every keystroke,
  // which would cause MilkdownEditor's useEditor to re-initialize and lose focus.
  const handleBodyChange = useCallback(
    (newBody: string) => {
      bodyRef.current = newBody;
      emit(metadataRef.current, newBody);
    },
    [emit],
  );

  const handleMetadataChange = useCallback(
    (field: 'name' | 'description', value: string) => {
      setMetadata((prev) => {
        if (!prev) return prev;
        const updated = { ...prev, [field]: value };
        metadataRef.current = updated;
        emit(updated, bodyRef.current);
        return updated;
      });
    },
    [emit],
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <SkillMetadataHeader metadata={metadata} onMetadataChange={onChange ? handleMetadataChange : undefined} />

      <ScrollArea className="min-h-0 flex-1">
        <div className="h-full w-full p-4">
          <MilkdownEditor content={parsed.body} onChange={handleBodyChange} />
        </div>
      </ScrollArea>
    </div>
  );
}
