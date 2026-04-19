import { Video } from 'lucide-react';

interface MockSession {
  id: string;
  title: string;
  started: string;
  ended: string | null;
}

const MOCK_SESSIONS: MockSession[] = [
  { id: 's1', title: 'Debug retry logic', started: 'Today 10:04', ended: null },
  { id: 's2', title: 'Pair on billing flow', started: 'Yesterday', ended: 'Yesterday' },
  { id: 's3', title: 'Code review: ingest', started: 'Mon', ended: 'Mon' },
];

export function SessionsCategory() {
  return (
    <ul className="flex flex-col gap-0.5">
      {MOCK_SESSIONS.map((s) => (
        <li
          key={s.id}
          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Video className="h-3.5 w-3.5 flex-shrink-0" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate">{s.title}</span>
            <span className="text-[10px] text-muted-foreground">
              {s.ended ? s.ended : `Live · ${s.started}`}
            </span>
          </div>
          {!s.ended && (
            <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
          )}
        </li>
      ))}
    </ul>
  );
}
