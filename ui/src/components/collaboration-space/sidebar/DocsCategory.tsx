import { FileText } from 'lucide-react';

const MOCK_DOCS = [
  { id: 'd1', title: 'Onboarding notes.md' },
  { id: 'd2', title: 'Retry policy RFC.md' },
];

export function DocsCategory() {
  return (
    <ul className="flex flex-col gap-0.5">
      {MOCK_DOCS.map((d) => (
        <li
          key={d.id}
          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <FileText className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{d.title}</span>
        </li>
      ))}
      {MOCK_DOCS.length === 0 && (
        <li className="px-2 py-1.5 text-xs italic text-muted-foreground">No docs shared</li>
      )}
    </ul>
  );
}
