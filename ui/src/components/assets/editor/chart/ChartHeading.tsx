/** A chart's title, then what it is (CHART.md's description) in a few lines. */
export function ChartHeading({ title, description }: { title: string; description?: string | null }) {
  return (
    <>
      <h1 className="m-0 text-xl font-semibold" data-testid="chart-title">
        {title}
      </h1>
      {description && (
        <p
          className="mt-1 max-w-[80ch] text-sm"
          style={{ color: 'var(--text-primary)' }}
          data-testid="chart-description"
        >
          {description}
        </p>
      )}
    </>
  );
}
