/**
 * CostSparkline - Minimal area chart for displaying trends.
 */

import { Area, AreaChart } from 'recharts';

interface SparklineDataPoint {
  value: number;
}

interface CostSparklineProps {
  data: SparklineDataPoint[];
  color: string;
}

export function CostSparkline({ data, color }: CostSparklineProps) {
  if (data.length === 0) {
    return <div className="h-6 w-16" />;
  }

  return (
    <div className="h-6 w-16">
      <AreaChart width={64} height={24} data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`gradient-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.4} />
            <stop offset="100%" stopColor={color} stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#gradient-${color.replace('#', '')})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </div>
  );
}
