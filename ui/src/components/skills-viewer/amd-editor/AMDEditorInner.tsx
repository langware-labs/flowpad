import { InstructionElementType, SkillParser } from '@sdk';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { Box, Code, FileText, GitBranch, MonitorPlay, Plus, Repeat, Settings } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SkillMetadataHeader } from '@src/components/assets/editor/skill/SkillMetadataHeader';
import { useAMDEditor } from './AMDEditorContext';
import { BlockPicker } from './components/BlockPicker';
import { ElementBlock } from './components/ElementBlock';
import { ElementToolbar } from './components/ElementToolbar';
import { ExecutionToolbar } from './components/ExecutionToolbar';
import { BLOCK_CONFIGS, CREATABLE_BLOCK_TYPES } from './types';

const QUICK_ICONS: Record<string, React.ReactNode> = {
  do: <Code className="h-7 w-7" />,
  if: <GitBranch className="h-7 w-7" />,
  each: <Repeat className="h-7 w-7" />,
  set: <Settings className="h-7 w-7" />,
  ui: <MonitorPlay className="h-7 w-7" />,
  block: <Box className="h-7 w-7" />,
  call: <FileText className="h-7 w-7" />,
};

interface AMDEditorInnerProps {
  initialContent: string;
  hideHeader?: boolean;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function AMDEditorInner({
  initialContent,
  hideHeader = false,
  isCollapsed = false,
  onToggleCollapse,
}: AMDEditorInnerProps) {
  const { elements, selectElement, addElement, loadFromContent, serializeToContent } = useAMDEditor();

  // Track if we've loaded content to avoid re-loading on re-renders
  const hasLoadedRef = useRef(false);
  const lastContentRef = useRef<string>('');

  // Load content once on mount or when initialContent changes externally
  useEffect(() => {
    // Only load if content is different from what we loaded before
    if (initialContent !== lastContentRef.current) {
      loadFromContent(initialContent);
      lastContentRef.current = initialContent;
      hasLoadedRef.current = true;
    }
  }, [initialContent, loadFromContent]);

  const handleBackgroundClick = () => {
    selectElement(null);
  };

  // Notion-style inline add button with quick-action icons
  const NotionAddButton = () => {
    const [isVisible, setIsVisible] = useState(false);
    const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const handleMouseEnter = () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
      setIsVisible(true);
    };

    const handleMouseLeave = () => {
      hideTimeoutRef.current = setTimeout(() => {
        setIsVisible(false);
      }, 1500);
    };

    useEffect(() => {
      return () => {
        if (hideTimeoutRef.current) {
          clearTimeout(hideTimeoutRef.current);
        }
      };
    }, []);

    return (
      <div
        className="flex items-center gap-2 px-2 py-1.5"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Plus button opens dropdown with descriptions */}
        <BlockPicker
          onSelect={(type) => addElement(type)}
          trigger={
            <button
              className="flex items-center justify-center rounded-md p-1 text-muted-foreground/50 transition-colors hover:bg-muted/50 hover:text-muted-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <Plus className="h-4 w-4" />
            </button>
          }
        />
        {/* Quick-action icon buttons */}
        <div
          className={`flex items-center gap-3 transition-opacity duration-300 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        >
          <TooltipProvider delayDuration={300}>
            {CREATABLE_BLOCK_TYPES.map((type: InstructionElementType) => {
              const config = BLOCK_CONFIGS[type];
              return (
                <Tooltip key={type}>
                  <TooltipTrigger asChild>
                    <button
                      className={`flex items-center justify-center rounded p-2 transition-colors hover:bg-muted/50 ${config.color.replace('border-', 'text-')}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        addElement(type);
                      }}
                    >
                      {QUICK_ICONS[type]}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {config.label}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </TooltipProvider>
        </div>
      </div>
    );
  };

  // Parse metadata from serialized content for the header (read-only display)
  const headerMetadata = (() => {
    if (hideHeader) return null;
    try {
      return SkillParser.parse(serializeToContent()).metadata;
    } catch {
      return null;
    }
  })();

  return (
    <div className="flex h-full flex-col">
      {/* Metadata Header */}
      {!hideHeader && <SkillMetadataHeader metadata={headerMetadata} />}

      {/* Toolbar - hide in session mode (hideHeader) */}
      {!hideHeader && <ElementToolbar />}

      {/* Content Area - fills panel, toolbar at bottom when collapsed */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Spacer that grows when collapsed to push toolbar to bottom */}
        {isCollapsed && <div className="flex-1" />}

        {/* Execution Toolbar - full-width bar in session mode, stays at bottom */}
        {hideHeader && <ExecutionToolbar isCollapsed={isCollapsed} onToggleCollapse={onToggleCollapse} />}

        {/* Hide content when collapsed - animate with 500ms using max-height */}
        <div
          className={`transition-all duration-500 ease-in-out ${
            isCollapsed ? 'max-h-0 overflow-hidden opacity-0' : 'max-h-[2000px] opacity-100'
          }`}
        >
          <ScrollArea className="h-full min-h-0 flex-1">
            <div className="px-3 pb-3 pt-0.5" onClick={handleBackgroundClick}>
              {elements.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
                  <p className="text-sm">No instructions yet</p>
                  {hideHeader ? (
                    <div className="mt-4">
                      <NotionAddButton />
                    </div>
                  ) : (
                    <p className="mt-1 text-xs">Click Add Block above to get started</p>
                  )}
                </div>
              ) : (
                <div className="space-y-0.5">
                  {elements.map((element) => (
                    <ElementBlock key={element.localId} element={element} />
                  ))}
                  {/* Notion-style add button at the end */}
                  {hideHeader && (
                    <div className="mt-2">
                      <NotionAddButton />
                    </div>
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
