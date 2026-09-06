/**
 * A live-session lifecycle line ("Dana approved the live session") — a slim,
 * centered, messenger-style system line, never a bubble. Rendered inside the
 * session view (the thread hides session lines).
 */
export function SessionEventLine({ text }: { text: string }) {
  return (
    <div data-testid="session-event-line" className="py-0.5 text-center text-[11px] italic text-muted-foreground/80">
      {text}
    </div>
  );
}
