import { Area, AreaChart, ResponsiveContainer } from "recharts";

/** The traffic cell's last minute of bandwidth, drawn with recharts. */
export function BandwidthSparkline({
  data,
  gradientId,
}: {
  data: { time: number; bandwidth: number }[];
  gradientId: string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
      <AreaChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.6} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.1} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="bandwidth"
          stroke="var(--chart-1)"
          strokeWidth={1}
          fill={`url(#${gradientId})`}
          isAnimationActive={false}
          dot={false}
          activeDot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
