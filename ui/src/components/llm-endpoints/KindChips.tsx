/** What an API endpoint serves (`image.generate`, `video.generate`), one chip per kind. */
export function KindChips({ kinds }: { kinds?: readonly string[] | null }) {
  return (
    <>
      {(kinds ?? []).map((kind) => (
        <span key={kind} className="whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {kind}
        </span>
      ))}
    </>
  );
}
