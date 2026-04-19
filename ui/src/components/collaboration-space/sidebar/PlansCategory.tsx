import { ListChecks } from 'lucide-react';

const MOCK_PLANS = [
  { id: 'p1', title: 'Ingest pipeline stabilization' },
];

export function PlansCategory() {
  return (
    <ul className="flex flex-col gap-0.5">
      {MOCK_PLANS.map((p) => (
        <li
          key={p.id}
          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ListChecks className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{p.title}</span>
        </li>
      ))}
      {MOCK_PLANS.length === 0 && (
        <li className="px-2 py-1.5 text-xs italic text-muted-foreground">No plans shared</li>
      )}
    </ul>
  );
}
