import { Trans } from '@lingui/react/macro';

export function Greeting({ firstName }: { firstName: string }) {
  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight">
        <Trans>
          Hey{' '}
          <span className="bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
            {firstName}
          </span>
        </Trans>
      </h1>
      <p className="text-lg text-muted-foreground">
        <Trans>What would you like to work on today?</Trans>
      </p>
    </>
  );
}
