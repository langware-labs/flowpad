const SINGLE_POSITION_RATIO = 0.08;

/** Camera ratio for a visible graph span; smaller ratios zoom further in. */
export function cameraRatioForVisibleSpan(span: number, positionedNodes: number): number {
  if (!Number.isFinite(span) || span <= 0 || positionedNodes <= 1) return SINGLE_POSITION_RATIO;
  return span * 1.4;
}
