import { Trans, useLingui } from '@lingui/react/macro';
import { COLD_HEAT_COLOR, HOT_HEAT_COLOR, UNKNOWN_HEAT_COLOR, type WorldViewHeatSummary } from '../graph/heat';

type Props = {
  summary: WorldViewHeatSummary;
};

export function HeatLegend({ summary }: Props) {
  const { t } = useLingui();
  const isTypeMode = summary.mode === 'type';
  const { known, total, cohorts, stale, signal, unknown } = summary;
  const cohortNote = cohorts > 1 ? t` · ${cohorts} comparable cohorts` : '';
  const staleNote = stale > 0 ? t` · ${stale} stale` : '';

  return (
    <aside className="heat-legend" aria-label={t`${signal} color legend`}>
      <div className="heat-legend-heading">
        <strong>{summary.signal}</strong>
        <span>
          <Trans>
            {known}/{total} coverage
          </Trans>
          {cohortNote}
          {staleNote}
        </span>
      </div>
      {isTypeMode ? (
        <div className="heat-type-scale">
          <Trans>Entity type colors</Trans>
        </div>
      ) : (
        <>
          <div className="heat-scale" aria-hidden="true" />
          <div className="heat-scale-labels">
            <span style={{ color: COLD_HEAT_COLOR }}>
              <Trans>Cold</Trans>
            </span>
            <span style={{ color: HOT_HEAT_COLOR }}>
              <Trans>Hot</Trans>
            </span>
          </div>
        </>
      )}
      <div className="heat-unknown">
        <span className="heat-unknown-dot" style={{ backgroundColor: UNKNOWN_HEAT_COLOR }} />
        <span>
          <Trans>Unknown · {unknown}</Trans>
        </span>
      </div>
    </aside>
  );
}
