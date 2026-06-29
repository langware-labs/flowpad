import { Button } from '@src/components/ui/button';
import { Plus } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { useAMDEditor } from '../AMDEditorContext';
import { AMDElement, isContainerType } from '../types';
import { BlockWrapper } from './BlockWrapper';
import { BlockBlock } from './blocks/BlockBlock';
import { CallBlock } from './blocks/CallBlock';
import { DoBlock } from './blocks/DoBlock';
import { EachBlock } from './blocks/EachBlock';
import { IfBlock } from './blocks/IfBlock';
import { SetBlock } from './blocks/SetBlock';
import { TextBlock } from './blocks/TextBlock';
import { UiBlock } from './blocks/UiBlock';
import { BlockPicker } from './BlockPicker';

interface ElementBlockProps {
  element: AMDElement;
  depth?: number;
  parentId?: string;
}

function renderBlockByType(element: AMDElement) {
  switch (element.element.elementType) {
    case 'do':
      return <DoBlock element={element} />;
    case 'if':
      return <IfBlock element={element} />;
    case 'each':
      return <EachBlock element={element} />;
    case 'set':
      return <SetBlock element={element} />;
    case 'ui':
      return <UiBlock element={element} />;
    case 'block':
      return <BlockBlock element={element} />;
    case 'call':
      return <CallBlock element={element} />;
    case 'text':
      return <TextBlock element={element} />;
    case 'header':
      return null;
    default:
      return <div className="text-xs text-muted-foreground"><Trans>Unknown block</Trans></div>;
  }
}

export function ElementBlock({ element, depth = 0, parentId: _parentId }: ElementBlockProps) {
  const { expandedIds, addElement } = useAMDEditor();
  const isContainer = isContainerType(element.element.elementType);
  const isExpanded = expandedIds.has(element.localId);

  // Skip header elements
  if (element.element.elementType === 'header') {
    return null;
  }

  return (
    <div className="mb-0.5">
      <BlockWrapper element={element} depth={depth}>
        {renderBlockByType(element)}
      </BlockWrapper>

      {/* Render children for expanded containers */}
      {isContainer && isExpanded && (
        <div className="ml-8 mt-0.5 border-l border-muted-foreground/10 pl-2">
          {element.children.map((child) => (
            <ElementBlock key={child.localId} element={child} depth={depth + 1} parentId={element.localId} />
          ))}

          {/* Add child button */}
          <BlockPicker
            onSelect={(type) => addElement(type, element.localId)}
            trigger={
              <Button
                variant="ghost"
                size="sm"
                className="mt-0.5 h-5 px-2 text-[10px] text-muted-foreground/60 hover:text-muted-foreground"
              >
                <Plus className="mr-0.5 h-3 w-3" />
                <Trans>add</Trans>
              </Button>
            }
          />
        </div>
      )}
    </div>
  );
}
