import { useMemo } from "react";
import { extent } from "d3-array";
import { scaleLinear } from "d3-scale";
import { line } from "d3-shape";
import {
  findIndexAtOrBefore,
  getTackFromTwa,
  smoothWindSamples,
  type Tack,
} from "../data/windSamples";
import type { WindSamplesColumnar } from "../types/race";

type WindHistoryPanelProps = {
  samples: WindSamplesColumnar;
  currentRaceTimeMs: number;
  historyDurationMinutes: number;
};

type PlotPoint = {
  ageMinutes: number;
  value: number;
  twa?: number | null;
  // Smoothed value at the same time, used to unwrap TWD and to spot outliers.
  reference?: number | null;
};

type ColoredPathSegment = {
  key: string;
  tack: Tack;
  points: PlotPoint[];
};

type WindTrend = {
  symbol: string;
  label: string;
  change: string;
  isSteady: boolean;
};

type PaddedDomainOptions = {
  minimumSpan: number;
  paddingRatio: number;
  lowerBound?: number;
  upperBound?: number;
  roundToIncrement?: number;
};

const WIDTH = 420;
const HEIGHT = 652;
const MARGIN = {
  top: 32,
  right: 24,
  bottom: 64,
  left: 48,
};

const INNER_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const INNER_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const PANEL_GAP = 36;
const SUBPLOT_WIDTH = (INNER_WIDTH - PANEL_GAP) / 2;
const SMOOTHING_TIME_CONSTANT_SECONDS = 1 * 60;
const TREND_WINDOW_MINUTES = 1;
const TWD_STEADY_THRESHOLD_DEGREES = 2;
const TWS_STEADY_THRESHOLD_KNOTS = 0.3;
// Raw samples further than this many robust standard deviations (1.4826 × MAD
// of the residuals from the smoothed line) are left out of the axis range.
const OUTLIER_THRESHOLD_SIGMAS = 5;
const TWD_MIN_OUTLIER_DEVIATION_DEGREES = 15;
const TWS_MIN_OUTLIER_DEVIATION_KNOTS = 3;

export function WindHistoryPanel({
  samples,
  currentRaceTimeMs,
  historyDurationMinutes,
}: WindHistoryPanelProps) {
  const smoothed = useMemo(
    () => smoothWindSamples(samples, SMOOTHING_TIME_CONSTANT_SECONDS),
    [samples],
  );

  const { twdPoints, twsPoints, twdSmoothPoints, twsSmoothPoints } = useMemo(() => {
    const windowStartMs = currentRaceTimeMs - historyDurationMinutes * 60_000;

    const twd: PlotPoint[] = [];
    const tws: PlotPoint[] = [];
    const twdSmooth: PlotPoint[] = [];
    const twsSmooth: PlotPoint[] = [];
    // TWD is unwrapped as it is collected (oldest first), so a wind near north
    // plots as e.g. -3° next to 5° instead of jumping across the 0-360 axis.
    let twdAnchor: number | undefined;

    for (let index = 0; index < samples.timeMs.length; index += 1) {
      const sampleTimeMs = samples.timeMs[index];

      if (sampleTimeMs < windowStartMs || sampleTimeMs > currentRaceTimeMs) {
        continue;
      }

      const ageMinutes = (currentRaceTimeMs - sampleTimeMs) / 60_000;
      const twsValue = samples.tws[index];
      const twaValue = samples.twa?.[index] ?? null;
      const twsSmoothValue = smoothed.tws[index];
      const twdSmoothValue = unwrapAngle(smoothed.twd[index], twdAnchor);
      twdAnchor = twdSmoothValue ?? twdAnchor;
      const twdValue = unwrapAngle(samples.twd[index], twdAnchor);
      twdAnchor = twdSmoothValue ?? twdValue ?? twdAnchor;

      if (twdValue !== null && twdValue !== undefined) {
        twd.push({
          ageMinutes,
          value: twdValue,
          twa: twaValue,
          reference: twdSmoothValue,
        });
      }

      if (twsValue !== null && twsValue !== undefined) {
        tws.push({
          ageMinutes,
          value: twsValue,
          reference: twsSmoothValue,
        });
      }

      if (twdSmoothValue !== null) {
        twdSmooth.push({
          ageMinutes,
          value: twdSmoothValue,
        });
      }

      if (twsSmoothValue !== null) {
        twsSmooth.push({
          ageMinutes,
          value: twsSmoothValue,
        });
      }
    }

    return {
      twdPoints: twd,
      twsPoints: tws,
      twdSmoothPoints: twdSmooth,
      twsSmoothPoints: twsSmooth,
    };
  }, [currentRaceTimeMs, historyDurationMinutes, samples, smoothed]);

  const yScale = scaleLinear()
    .domain([0, historyDurationMinutes])
    .range([0, INNER_HEIGHT]);

  const currentTwdExtent = buildRobustExtent(
    twdPoints,
    twdSmoothPoints,
    TWD_MIN_OUTLIER_DEVIATION_DEGREES,
  );
  const currentTwsExtent = buildRobustExtent(
    twsPoints,
    twsSmoothPoints,
    TWS_MIN_OUTLIER_DEVIATION_KNOTS,
  );

  const twdDomain = buildPaddedDomain(currentTwdExtent[0], currentTwdExtent[1], {
    minimumSpan: 10,
    paddingRatio: 0.12,
    roundToIncrement: 5,
  });

  const twsDomain = buildPaddedDomain(currentTwsExtent[0], currentTwsExtent[1], {
    minimumSpan: 1,
    paddingRatio: 0.15,
    lowerBound: 0,
    roundToIncrement: 1,
  });

  const twdScale = scaleLinear().domain(twdDomain).range([0, SUBPLOT_WIDTH]);
  const twsScale = scaleLinear().domain(twsDomain).range([0, SUBPLOT_WIDTH]);

  const twdPathSegments = buildColoredTwdSegments(twdPoints);
  const twsPath = buildPath(twsPoints, twsScale, yScale);
  const twdSmoothPath = buildPath(twdSmoothPoints, twdScale, yScale);
  const twsSmoothPath = buildPath(twsSmoothPoints, twsScale, yScale);
  const twdTitle = `TWD ${formatTwdValue(getCurrentValue(twdSmoothPoints))}`;
  const twsTitle = `TWS ${formatTwsValue(getCurrentValue(twsSmoothPoints))}`;

  const { twdTrend, twsTrend } = useMemo(() => {
    const currentIndex = findIndexAtOrBefore(samples.timeMs, currentRaceTimeMs);
    const pastIndex = findIndexAtOrBefore(
      samples.timeMs,
      currentRaceTimeMs - TREND_WINDOW_MINUTES * 60_000,
    );

    return {
      twdTrend: buildTwdTrend(smoothed.twd[currentIndex], smoothed.twd[pastIndex]),
      twsTrend: buildTwsTrend(smoothed.tws[currentIndex], smoothed.tws[pastIndex]),
    };
  }, [currentRaceTimeMs, samples, smoothed]);

  const ageTicks = buildAgeTicks(historyDurationMinutes);
  const twdTicks = buildValueTicks(twdDomain);
  const twsTicks = buildValueTicks(twsDomain);

  return (
    <section className="panel wind-panel">
      <svg
        className="wind-history-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Wind history plot"
      >
        <defs>
          <clipPath id="wind-subplot-clip">
            <rect width={SUBPLOT_WIDTH} height={INNER_HEIGHT} />
          </clipPath>
        </defs>
        <g transform={`translate(${MARGIN.left}, ${MARGIN.top})`}>
          {ageTicks.map((tick) => (
            <g key={tick} transform={`translate(0, ${yScale(tick)})`}>
              <line className="grid-line" x1={0} x2={INNER_WIDTH} y1={0} y2={0} />
              <text className="age-label" x={-10} y={4} textAnchor="end">
                {tick}
              </text>
            </g>
          ))}

          <text className="axis-caption" x={-34} y={-10}>
            min ago
          </text>

          <g>
            <text className="plot-title" x={SUBPLOT_WIDTH / 2} y={-10} textAnchor="middle">
              {twdTitle}
            </text>

            {twdTicks.map((tick) => (
              <g key={tick} transform={`translate(${twdScale(tick)}, 0)`}>
                <line className="vertical-grid-line" x1={0} x2={0} y1={0} y2={INNER_HEIGHT} />
                <text className="x-label" x={0} y={INNER_HEIGHT + 20} textAnchor="middle">
                  {formatTick(normalizeDegrees(tick))}
                </text>
              </g>
            ))}

            <g clipPath="url(#wind-subplot-clip)">
              {twdPathSegments.map((segment) => (
                <path
                  key={segment.key}
                  className={
                    segment.tack === "port"
                      ? "twd-line-port"
                      : "twd-line-starboard"
                  }
                  d={buildPath(segment.points, twdScale, yScale)}
                />
              ))}

              <path className="wind-smooth-line" d={twdSmoothPath} />
            </g>
            <rect className="plot-border" width={SUBPLOT_WIDTH} height={INNER_HEIGHT} />
            <TrendIndicator trend={twdTrend} />
          </g>

          <g transform={`translate(${SUBPLOT_WIDTH + PANEL_GAP}, 0)`}>
            <text className="plot-title" x={SUBPLOT_WIDTH / 2} y={-10} textAnchor="middle">
              {twsTitle}
            </text>

            {twsTicks.map((tick) => (
              <g key={tick} transform={`translate(${twsScale(tick)}, 0)`}>
                <line className="vertical-grid-line" x1={0} x2={0} y1={0} y2={INNER_HEIGHT} />
                <text className="x-label" x={0} y={INNER_HEIGHT + 20} textAnchor="middle">
                  {formatTick(tick)}
                </text>
              </g>
            ))}

            <g clipPath="url(#wind-subplot-clip)">
              <path className="tws-line" d={twsPath} />
              <path className="wind-smooth-line" d={twsSmoothPath} />
            </g>
            <rect className="plot-border" width={SUBPLOT_WIDTH} height={INNER_HEIGHT} />
            <TrendIndicator trend={twsTrend} />
          </g>
        </g>
      </svg>
    </section>
  );
}

function TrendIndicator({ trend }: { trend: WindTrend | null }) {
  if (!trend) {
    return null;
  }

  return (
    <text
      className={trend.isSteady ? "trend-label trend-label-steady" : "trend-label"}
      x={SUBPLOT_WIDTH / 2}
      y={INNER_HEIGHT + 48}
      textAnchor="middle"
    >
      <tspan className="trend-symbol">{trend.symbol}</tspan> {trend.label}
      <tspan className="trend-change"> {trend.change}</tspan>
    </text>
  );
}

function buildTwdTrend(
  current: number | null | undefined,
  past: number | null | undefined,
): WindTrend | null {
  if (current === null || current === undefined || past === null || past === undefined) {
    return null;
  }

  // Positive = clockwise shift = veering.
  const delta = Math.round(((current - past + 540) % 360) - 180);
  const change = `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(0)}° / ${TREND_WINDOW_MINUTES} min`;

  if (Math.abs(delta) < TWD_STEADY_THRESHOLD_DEGREES) {
    return { symbol: "•", label: "Steady", change, isSteady: true };
  }

  return delta > 0
    ? { symbol: "↻", label: "Veering", change, isSteady: false }
    : { symbol: "↺", label: "Backing", change, isSteady: false };
}

function buildTwsTrend(
  current: number | null | undefined,
  past: number | null | undefined,
): WindTrend | null {
  if (current === null || current === undefined || past === null || past === undefined) {
    return null;
  }

  const delta = Math.round((current - past) * 10) / 10;
  const change = `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)} kt / ${TREND_WINDOW_MINUTES} min`;

  if (Math.abs(delta) < TWS_STEADY_THRESHOLD_KNOTS) {
    return { symbol: "•", label: "Steady", change, isSteady: true };
  }

  return delta > 0
    ? { symbol: "▲", label: "Building", change, isSteady: false }
    : { symbol: "▼", label: "Easing", change, isSteady: false };
}

function buildColoredTwdSegments(points: PlotPoint[]): ColoredPathSegment[] {
  const segments: ColoredPathSegment[] = [];
  let currentSegment: ColoredPathSegment | null = null;

  for (const point of points) {
    const tack = getTackFromTwa(point.twa);

    if (!currentSegment || currentSegment.tack !== tack) {
      currentSegment = {
        key: `twd-${segments.length}-${tack}`,
        tack,
        points: [],
      };

      segments.push(currentSegment);
    }

    currentSegment.points.push(point);
  }

  return segments.filter((segment) => segment.points.length >= 2);
}

function buildPath(
  points: PlotPoint[],
  xScale: (value: number) => number,
  yScale: (value: number) => number,
): string {
  return (
    line<PlotPoint>()
      .x((point) => xScale(point.value))
      .y((point) => yScale(point.ageMinutes))(points) ?? ""
  );
}

// Shifts an angle by a multiple of 360 so it is within 180 of the anchor.
function unwrapAngle(
  value: number | null | undefined,
  anchor: number | undefined,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (anchor === undefined) {
    return value;
  }

  return anchor + ((((value - anchor) % 360) + 540) % 360) - 180;
}

// Value range for the axis: the whole smoothed line plus the raw samples that
// are not outliers. A raw sample is an outlier when its distance from the
// smoothed line exceeds both minimumDeviation and OUTLIER_THRESHOLD_SIGMAS
// robust standard deviations of all such distances in the window. Outliers
// still get drawn, but they run off the edge of the plot instead of
// stretching the axis.
function buildRobustExtent(
  rawPoints: PlotPoint[],
  smoothPoints: PlotPoint[],
  minimumDeviation: number,
): [number | undefined, number | undefined] {
  const deviations = rawPoints
    .filter((point) => point.reference !== null && point.reference !== undefined)
    .map((point) => Math.abs(point.value - (point.reference as number)))
    .sort((a, b) => a - b);
  const medianDeviation = deviations[Math.floor(deviations.length / 2)] ?? 0;
  const threshold = Math.max(
    minimumDeviation,
    OUTLIER_THRESHOLD_SIGMAS * 1.4826 * medianDeviation,
  );

  const inliers = rawPoints.filter(
    (point) =>
      point.reference === null ||
      point.reference === undefined ||
      Math.abs(point.value - point.reference) <= threshold,
  );

  const [rawMin, rawMax] = extent(inliers, (point) => point.value);
  const [smoothMin, smoothMax] = extent(smoothPoints, (point) => point.value);

  return [minDefined(rawMin, smoothMin), maxDefined(rawMax, smoothMax)];
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}

function getCurrentValue(points: PlotPoint[]): number | undefined {
  if (points.length === 0) {
    return undefined;
  }

  return points[points.length - 1]?.value;
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function buildAgeTicks(durationMinutes: number): number[] {
  if (durationMinutes <= 15) {
    return [0, 5, 10, 15].filter((tick) => tick <= durationMinutes);
  }

  if (durationMinutes <= 30) {
    return [0, 10, 20, 30].filter((tick) => tick <= durationMinutes);
  }

  if (durationMinutes <= 60) {
    return [0, 15, 30, 45, 60].filter((tick) => tick <= durationMinutes);
  }

  return [0, 30, 60, 90, 120].filter((tick) => tick <= durationMinutes);
}

function buildPaddedDomain(
  minValue: number | undefined,
  maxValue: number | undefined,
  options: PaddedDomainOptions,
): [number, number] {
  if (minValue === undefined || maxValue === undefined) {
    return [options.lowerBound ?? 0, options.upperBound ?? options.minimumSpan];
  }

  const center = (minValue + maxValue) / 2;
  const rawSpan = Math.max(maxValue - minValue, options.minimumSpan);
  const paddedSpan = rawSpan * (1 + options.paddingRatio * 2);

  let lower = center - paddedSpan / 2;
  let upper = center + paddedSpan / 2;

  if (options.lowerBound !== undefined && lower < options.lowerBound) {
    const shift = options.lowerBound - lower;
    lower += shift;
    upper += shift;
  }

  if (options.upperBound !== undefined && upper > options.upperBound) {
    const shift = upper - options.upperBound;
    lower -= shift;
    upper -= shift;
  }

  if (options.lowerBound !== undefined) {
    lower = Math.max(options.lowerBound, lower);
  }

  if (options.upperBound !== undefined) {
    upper = Math.min(options.upperBound, upper);
  }

  if (options.roundToIncrement !== undefined && options.roundToIncrement > 0) {
    const increment = options.roundToIncrement;
    lower = Math.floor(lower / increment) * increment;
    upper = Math.ceil(upper / increment) * increment;

    if (options.lowerBound !== undefined) {
      lower = Math.max(options.lowerBound, lower);
    }

    if (options.upperBound !== undefined) {
      upper = Math.min(options.upperBound, upper);
    }
  }

  if (lower === upper) {
    upper = lower + options.minimumSpan;
  }

  return [lower, upper];
}

function buildValueTicks(domain: [number, number]): number[] {
  const [minValue, maxValue] = domain;
  const midValue = (minValue + maxValue) / 2;

  return [minValue, midValue, maxValue];
}

function formatTick(value: number): string {
  if (Math.abs(value) >= 100) {
    return value.toFixed(0);
  }

  if (Math.abs(value) >= 10) {
    return value.toFixed(1);
  }

  return value.toFixed(2);
}

function formatTwdValue(value: number | undefined): string {
  if (value === undefined) {
    return "n/a";
  }

  return `${Math.round(normalizeDegrees(value))}°`;
}

function formatTwsValue(value: number | undefined): string {
  if (value === undefined) {
    return "n/a";
  }

  return `${value.toFixed(1)} kt`;
}