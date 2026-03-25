import { Button } from '@src/components/ui/button';
import { Plus } from 'lucide-react';
import { useAMDEditor } from '../AMDEditorContext';
import { BlockPicker } from './BlockPicker';

export function ElementToolbar() {
  const { addElement } = useAMDEditor();

  return (
    <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
      <BlockPicker
        onSelect={(type) => addElement(type)}
        trigger={
          <Button variant="outline" size="sm" className="h-7">
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add Block
          </Button>
        }
      />
    </div>
  );
}
