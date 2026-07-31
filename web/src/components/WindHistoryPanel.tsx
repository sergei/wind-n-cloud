import { useMemo } from "react";
import { extent, max } from "d3-array";
import { scaleLinear } from "d3-scale";
import { line } from "d3-shape";
import type { WindSamplesColumnar } from "../types/race";

type WindHistoryPanelProps = {
  samples: WindSamplesColumnar;
  currentRaceTimeMs: number;
  historyDurationMinutes: number;
};

type PlotPoint = {
  ageMinutes: number;
  value: number;
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

      if (twdValue !== null && twdValue !== undefined) {
        twd.push({
          ageMinutes,
          value: twdValue,
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

  const twdScale = scaleLinear().domain([0, 360]).range([0, SUBPLOT_WIDTH]);

  const twsMax = Math.max(10, Math.ceil((max(twsPoints, (point) => point.value) ?? 10) / 5) * 5);
  const twsScale = scaleLinear().domain([0, twsMax]).range([0, SUBPLOT_WIDTH]);

  const twdPath = buildPath(twdPoints, twdScale, yScale);
  const twsPath = buildPath(twsPoints, twsScale, yScale);

  const ageTicks = buildAgeTicks(historyDurationMinutes);
  const twdTicks = [0, 90, 180, 270, 360];
  const twsTicks = buildSpeedTicks(twsMax);

  const currentTwdExtent = extent(twdPoints, (point) => point.value);
  const currentTwsExtent = extent(twsPoints, (point) => point.value);

  return (
    <section className="panel wind-panel">
      <div className="panel-header">
        <div>
          <h2>Wind history</h2>
          <div className="panel-subtitle">
            Newest at top · {historyDurationMinutes} min window
          </div>
        </div>
      </div>

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
              TWD
            </text>

            {twdTicks.map((tick) => (
              <g key={tick} transform={`translate(${twdScale(tick)}, 0)`}>
                <line className="vertical-grid-line" x1={0} x2={0} y1={0} y2={INNER_HEIGHT} />
                <text className="x-label" x={0} y={INNER_HEIGHT + 20} textAnchor="middle">
                  {tick}
                </text>
              </g>
            ))}

            <path className="twd-line" d={twdPath} />
            <rect className="plot-border" width={SUBPLOT_WIDTH} height={INNER_HEIGHT} />
          </g>

          <g transform={`translate(${SUBPLOT_WIDTH + PANEL_GAP}, 0)`}>
            <text className="plot-title" x={SUBPLOT_WIDTH / 2} y={-10} textAnchor="middle">
              TWS
            </text>

            {twsTicks.map((tick) => (
              <g key={tick} transform={`translate(${twsScale(tick)}, 0)`}>
                <line className="vertical-grid-line" x1={0} x2={0} y1={0} y2={INNER_HEIGHT} />
                <text className="x-label" x={0} y={INNER_HEIGHT + 20} textAnchor="middle">
                  {tick}
                </text>
              </g>
            ))}

            <path className="tws-line" d={twsPath} />
            <rect className="plot-border" width={SUBPLOT_WIDTH} height={INNER_HEIGHT} />
          </g>
        </g>
      </svg>

      <div className="wind-stats">
        <span>
          TWD range: {formatRange(currentTwdExtent[0], currentTwdExtent[1], "°")}
        </span>
        <span>
          TWS range: {formatRange(currentTwsExtent[0], currentTwsExtent[1], " kt")}
        </span>
      </div>
    </section>
  );
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

function buildSpeedTicks(maxSpeed: number): number[] {
  const step = maxSpeed <= 10 ? 2 : 5;
  const ticks: number[] = [];

  for (let value = 0; value <= maxSpeed; value += step) {
    ticks.push(value);
  }

  return ticks;
}

function formatRange(minValue: number | undefined, maxValue: number | undefined, suffix: string): string {
  if (minValue === undefined || maxValue === undefined) {
    return "n/a";
  }

  return `${minValue.toFixed(1)}–${maxValue.toFixed(1)}${suffix}`;
}
