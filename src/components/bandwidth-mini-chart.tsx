import * as React from "react";
import { lazyNamed } from "@/lib/lazy-named";
import { cn } from "@/lib/utils";
import type { BandwidthDataPoint } from "@/types";

const BandwidthSparkline = lazyNamed(
  () => import("@/components/bandwidth-sparkline"),
  "BandwidthSparkline",
);

interface BandwidthMiniChartProps {
  data: BandwidthDataPoint[];
  currentBandwidth?: number;
  onClick?: () => void;
  className?: string;
  "aria-label"?: string;
}

export function BandwidthMiniChart({
  data,
  currentBandwidth: externalBandwidth,
  onClick,
  className,
  "aria-label": ariaLabel,
}: BandwidthMiniChartProps) {
  // One gradient per chart: rows that share an id all paint with the first
  // row's gradient, and lose it when that row unmounts.
  const gradientId = `bandwidth-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // Transform data for the chart - combine sent and received for total bandwidth
  const chartData = React.useMemo(() => {
    // Fill in missing seconds with zeros for smooth chart
    if (data.length === 0) {
      // Create 60 seconds of zero data for the past minute
      const now = Math.floor(Date.now() / 1000);
      return Array.from({ length: 60 }, (_, i) => ({
        time: now - (59 - i),
        bandwidth: 0,
      }));
    }

    const now = Math.floor(Date.now() / 1000);
    const result: { time: number; bandwidth: number }[] = [];

    // Get the last 60 seconds
    for (let i = 59; i >= 0; i--) {
      const targetTime = now - i;
      const point = data.find((d) => d.timestamp === targetTime);
      result.push({
        time: targetTime,
        bandwidth: point ? point.bytes_sent + point.bytes_received : 0,
      });
    }

    return result;
  }, [data]);

  // Use external bandwidth if provided, otherwise calculate from last data point
  const currentBandwidth =
    externalBandwidth ?? chartData[chartData.length - 1]?.bandwidth ?? 0;

  // Format bytes to human readable
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B/s";
    if (bytes < 1024) return `${bytes} B/s`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={cn(
        "relative flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded border-none bg-transparent px-2 transition-colors hover:bg-foreground/8",
        className,
      )}
    >
      <div className="pointer-events-none h-3 min-w-0 flex-1">
        <React.Suspense fallback={null}>
          <BandwidthSparkline data={chartData} gradientId={gradientId} />
        </React.Suspense>
      </div>
      <span className="min-w-[60px] shrink-0 text-right text-xs whitespace-nowrap text-muted-foreground">
        {formatBytes(currentBandwidth)}
      </span>
    </button>
  );
}
