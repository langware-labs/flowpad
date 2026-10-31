/**
 * The chart views' shared tokens, so every chart format reads as one system (dataviz skill):
 * validated categorical slots in fixed order (blue, orange, aqua, violet; a 5th+ is neutral),
 * never cycled, with a separate dark set.
 */
export const CHART_LIGHT = {
  '--surface-0': '#f4f3f0',
  '--surface-1': '#fcfcfb',
  '--surface-2': '#f0efec',
  '--text-primary': '#0b0b0b',
  '--text-secondary': '#52514e',
  '--text-muted': '#8a8984',
  '--hairline': '#e3e2de',
  '--hairline-strong': '#c9c8c2',
  '--s1': '#2a78d6',
  '--s2': '#eb6834',
  '--s3': '#1baf7a',
  '--s4': '#6250d6',
  '--s-other': '#8a8984',
  '--focus': '#2a78d6',
};

export const CHART_DARK: typeof CHART_LIGHT = {
  '--surface-0': '#121211',
  '--surface-1': '#1a1a19',
  '--surface-2': '#252523',
  '--text-primary': '#f0efec',
  '--text-secondary': '#c3c2b7',
  '--text-muted': '#8f8e88',
  '--hairline': '#2e2e2b',
  '--hairline-strong': '#44443f',
  '--s1': '#3987e5',
  '--s2': '#d95926',
  '--s3': '#199e70',
  '--s4': '#9085e9',
  '--s-other': '#8f8e88',
  '--focus': '#3987e5',
};

export const CHART_SLOTS = ['--s1', '--s2', '--s3', '--s4'];

export const chartTokens = (theme: string | undefined) => (theme === 'dark' ? CHART_DARK : CHART_LIGHT);
