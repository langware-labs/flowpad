import { COLD_HEAT_COLOR, HOT_HEAT_COLOR, UNKNOWN_HEAT_COLOR, type WorldViewHeatSummary } from '../graph/heat';

type Props = {
  summary: WorldViewHeatSummary;
};

export function HeatLegend({ summary }: Props) {
  const isTypeMode = summary.mode === 'type';
  const coverage = `${summary.known}/${summary.total}`;
  const cohortNote = summary.cohorts > 1 ? ` · ${summary.cohorts} comparable cohorts` : '';
  const staleNote = summary.stale > 0 ? ` · ${summary.stale} stale` : '';

  return (
    <aside className="heat-legend" aria-label={`${summary.signal} color legend`}>
      <div className="heat-legend-heading">
        <strong>{summary.signal}</strong>
        <span>{coverage} coverage{cohortNote}{staleNote}</span>
      </div>
      {isTypeMode ? (
        <div className="heat-type-scale">Entity type colors</div>
      ) : (
        <>
          <div className="heat-scale" aria-hidden="true" />
          <div className="heat-scale-labels">
            <span style={{ color: COLD_HEAT_COLOR }}>Cold</span>
            <span style={{ color: HOT_HEAT_COLOR }}>Hot</span>
          </div>
        </>
      )}
      <div className="heat-unknown">
        <span className="heat-unknown-dot" style={{ backgroundColor: UNKNOWN_HEAT_COLOR }} />
        <span>Unknown · {summary.unknown}</span>
      </div>
    </aside>
  );
}
