import { MOCK_MESSAGES } from './mockMessages';

export function MessageList() {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
      {MOCK_MESSAGES.map((m) => (
        <div key={m.id} className="flex gap-2">
          <div
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${m.authorColor}`}
          >
            {m.author.slice(0, 1)}
          </div>
          <div className="flex min-w-0 flex-col">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-foreground">{m.author}</span>
              <span className="text-[10px] text-muted-foreground">{m.timestamp}</span>
            </div>
            <div className="text-sm text-foreground/90">{m.text}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
