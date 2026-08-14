import { useMemo } from "react";
import { extent } from "d3-array";
import { scaleLinear } from "d3-scale";
import { line } from "d3-shape";
import type { WindSamplesColumnar } from "../types/race";

type WindHistoryPanelProps = {
  samples: WindSamplesColumnar;
  currentRaceTimeMs: number;
  historyDurationMinutes: number;
};

type Tack = "port" | "starboard";

type PlotPoint = {
  ageMinutes: number;
  value: number;
  twa?: number | null;
};

type ColoredPathSegment = {
  key: string;
  tack: Tack;
  points: PlotPoint[];
};

type PaddedDomainOptions = {
  minimumSpan: number;
  paddingRatio: number;
  lowerBound?: number;
  upperBound?: number;
  roundToIncrement?: number;
};

const WIDTH = 420;
const HEIGHT = 620;
const MARGIN = {
  top: 32,
  right: 24,
  bottom: 32,
  left: 48,
};

const INNER_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const INNER_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const PANEL_GAP = 36;
const SUBPLOT_WIDTH = (INNER_WIDTH - PANEL_GAP) / 2;

export function WindHistoryPanel({
  samples,
  currentRaceTimeMs,
  historyDurationMinutes,
}: WindHistoryPanelProps) {
  const { twdPoints, twsPoints } = useMemo(() => {
    const windowStartMs = currentRaceTimeMs - historyDurationMinutes * 60_000;

    const twd: PlotPoint[] = [];
    const tws: PlotPoint[] = [];

    for (let index = 0; index < samples.timeMs.length; index += 1) {
      const sampleTimeMs = samples.timeMs[index];

      if (sampleTimeMs < windowStartMs || sampleTimeMs > currentRaceTimeMs) {
        continue;
      }

      const ageMinutes = (currentRaceTimeMs - sampleTimeMs) / 60_000;
      const twdValue = samples.twd[index];
      const twsValue = samples.tws[index];
      const twaValue = samples.twa?.[index] ?? null;

      if (twdValue !== null && twdValue !== undefined) {
        twd.push({
          ageMinutes,
          value: twdValue,
          twa: twaValue,
        });
      }

      if (twsValue !== null && twsValue !== undefined) {
        tws.push({
          ageMinutes,
          value: twsValue,
        });
      }
    }

    return {
      twdPoints: twd,
      twsPoints: tws,
    };
  }, [currentRaceTimeMs, historyDurationMinutes, samples]);

  const yScale = scaleLinear()
    .domain([0, historyDurationMinutes])
    .range([0, INNER_HEIGHT]);

  const currentTwdExtent = extent(twdPoints, (point) => point.value);
  const currentTwsExtent = extent(twsPoints, (point) => point.value);

  const twdDomain = buildPaddedDomain(currentTwdExtent[0], currentTwdExtent[1], {
    minimumSpan: 10,
    paddingRatio: 0.12,
    lowerBound: 0,
    upperBound: 360,
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
  const twdCurrent = getCurrentValue(twdPoints);
  const twsCurrent = getCurrentValue(twsPoints);
  const twdMedian = calculateCircularMedianDegrees(twdPoints.map((point) => point.value));
  const twsMedian = calculateMedian(twsPoints.map((point) => point.value));
  const twdTitle = `TWD ${formatTwdValue(twdCurrent)} · med ${formatTwdValue(twdMedian)}`;
  const twsTitle = `TWS ${formatTwsValue(twsCurrent)} · med ${formatTwsValue(twsMedian)}`;

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
                  {formatTick(tick)}
                </text>
              </g>
            ))}

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

            <rect className="plot-border" width={SUBPLOT_WIDTH} height={INNER_HEIGHT} />
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

            <path className="tws-line" d={twsPath} />
            <rect className="plot-border" width={SUBPLOT_WIDTH} height={INNER_HEIGHT} />
          </g>
        </g>
      </svg>
    </section>
  );
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

function getTackFromTwa(twa: number | null | undefined): Tack {
  if (twa === null || twa === undefined) {
    return "starboard";
  }

  return twa > 180 ? "port" : "starboard";
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

function getCurrentValue(points: PlotPoint[]): number | undefined {
  if (points.length === 0) {
    return undefined;
  }

  return points[points.length - 1]?.value;
}

function calculateMedian(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middleIndex = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middleIndex];
  }

  return (sorted[middleIndex - 1] + sorted[middleIndex]) / 2;
}

function calculateCircularMedianDegrees(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const reference = calculateCircularMeanDegrees(values);
  const unwrappedValues = values.map((value) => unwrapAngleAroundReference(value, reference));
  const unwrappedMedian = calculateMedian(unwrappedValues);

  if (unwrappedMedian === undefined) {
    return undefined;
  }

  return normalizeDegrees(unwrappedMedian);
}

function calculateCircularMeanDegrees(values: number[]): number {
  const sineSum = values.reduce(
    (sum, value) => sum + Math.sin((normalizeDegrees(value) * Math.PI) / 180),
    0,
  );
  const cosineSum = values.reduce(
    (sum, value) => sum + Math.cos((normalizeDegrees(value) * Math.PI) / 180),
    0,
  );

  if (Math.abs(sineSum) < 1e-12 && Math.abs(cosineSum) < 1e-12) {
    return normalizeDegrees(values[0] ?? 0);
  }

  return normalizeDegrees((Math.atan2(sineSum, cosineSum) * 180) / Math.PI);
}

function unwrapAngleAroundReference(value: number, reference: number): number {
  const normalizedValue = normalizeDegrees(value);
  const normalizedReference = normalizeDegrees(reference);
  const delta = ((normalizedValue - normalizedReference + 540) % 360) - 180;

  return normalizedReference + delta;
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