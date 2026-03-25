import { ContextSelect } from '../../../components/context-select';

interface ChatPanelBodyHeaderProps {
  selected: string[];
  available: string[];
  onToggle: (label: string) => void;
  onAdd: (label: string) => void;
  onRemove: (label: string) => void;
}

export function ChatPanelBodyHeader({
  selected,
  available: _available,
  onToggle,
  onAdd,
  onRemove,
}: ChatPanelBodyHeaderProps) {
  // available is required by interface but not used in this component
  void _available;
  return (
    <div data-testid="chat-panel-body-header" className="border-b bg-muted/30 px-3 py-2">
      <ContextSelect
        selectedLabels={selected}
        onSelect={onToggle}
        onRemove={onRemove}
        onAdd={onAdd}
        placeholder="Search ontology labels..."
      />
    </div>
  );
}
