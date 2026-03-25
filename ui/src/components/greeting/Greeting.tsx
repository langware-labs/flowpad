export function Greeting({ firstName }: { firstName: string }) {
  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight">
        Hey{' '}
        <span className="bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">{firstName}</span>
      </h1>
      <p className="text-lg text-muted-foreground">What would you like to work on today?</p>
    </>
  );
}
