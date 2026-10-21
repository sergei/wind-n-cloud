import { useEffect, useState } from "react";
import type { TimelineBand, TimelineBands } from "../playback/timelineBands";
import { formatDateTime } from "../utils/formatDateTime";
const DEBUG_PLAYBACK = false;

type TimelineControlsProps = {
  startTimeMs: number;
  endTimeMs: number;
  currentRaceTimeMs: number;
  isPlaying: boolean;
  historyDurationMinutes: number;
  availableHistoryDurationsMinutes: number[];
  bands: TimelineBands;
  onRaceTimeChange: (raceTimeMs: number) => void;
  onPlayingChange: (isPlaying: boolean) => void;
  onHistoryDurationChange: (durationMinutes: number) => void;
  onShare: () => Promise<void>;
};

export function TimelineControls({
  startTimeMs,
  endTimeMs,
  currentRaceTimeMs,
  isPlaying,
  historyDurationMinutes,
  availableHistoryDurationsMinutes,
  bands,
  onRaceTimeChange,
  onPlayingChange,
  onHistoryDurationChange,
  onShare,
}: TimelineControlsProps) {
  const [shareStatus, setShareStatus] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (shareStatus === "idle") {
      return;
    }

    const timeoutId = window.setTimeout(() => setShareStatus("idle"), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [shareStatus]);

  const handleShareClick = () => {
    onShare()
      .then(() => setShareStatus("copied"))
      .catch(() => setShareStatus("failed"));
  };

  const durationSeconds = Math.max(0, Math.round((endTimeMs - startTimeMs) / 1000));
  const currentOffsetSeconds = clamp(
    Math.round((currentRaceTimeMs - startTimeMs) / 1000),
    0,
    durationSeconds,
  );

  const handleOffsetChange = (offsetSeconds: number) => {
    const nextRaceTimeMs = startTimeMs + offsetSeconds * 1000;
    const clampedRaceTimeMs = clamp(nextRaceTimeMs, startTimeMs, endTimeMs);

    if (DEBUG_PLAYBACK) {
      console.log("[TimelineControls] slider change", {
        offsetSeconds,
        durationSeconds,
        startTimeMs,
        startIso: formatDateTime(startTimeMs),
        endTimeMs,
        endIso: formatDateTime(endTimeMs),
        currentRaceTimeMs,
        currentIso: formatDateTime(currentRaceTimeMs),
        nextRaceTimeMs,
        nextIso: formatDateTime(nextRaceTimeMs),
        clampedRaceTimeMs,
        clampedIso: formatDateTime(clampedRaceTimeMs),
      });
    }

    onRaceTimeChange(clampedRaceTimeMs);
  };

  const handlePlayPauseClick = () => {
    if (DEBUG_PLAYBACK) {
      console.log("[TimelineControls] play/pause click", {
        isPlayingBeforeClick: isPlaying,
        nextIsPlaying: !isPlaying,
        currentRaceTimeMs,
        currentIso: formatDateTime(currentRaceTimeMs),
        currentOffsetSeconds,
      });
    }

    onPlayingChange(!isPlaying);
  };

  return (
    <section className="timeline-controls">
      <div className="timeline-row">
        <button className="primary-button" onClick={handlePlayPauseClick}>
          {isPlaying ? "Pause" : "Play"}
        </button>

        <button
          onClick={() =>
            onRaceTimeChange(Math.max(startTimeMs, currentRaceTimeMs - 10_000))
          }
        >
          -10s
        </button>

        <button
          onClick={() =>
            onRaceTimeChange(Math.min(endTimeMs, currentRaceTimeMs + 10_000))
          }
        >
          +10s
        </button>

        <label className="history-selector">
          History
          <select
            value={historyDurationMinutes}
            onChange={(event) => onHistoryDurationChange(Number(event.target.value))}
          >
            {availableHistoryDurationsMinutes.map((duration) => (
              <option key={duration} value={duration}>
                {duration} min
              </option>
            ))}
          </select>
        </label>

        <button
          className="share-button"
          onClick={handleShareClick}
          title="Copy a link to the current time and view"
        >
          {shareStatus === "copied"
            ? "Link copied"
            : shareStatus === "failed"
              ? "Copy failed"
              : "Share"}
        </button>

        <div className="current-time-display">{formatDateTime(currentRaceTimeMs)}</div>
      </div>

      <div className="timeline-track">
        <div className="timeline-bands" aria-hidden="true">
          {bands.daylight.length > 0 && (
            <div className="timeline-lane timeline-lane-daylight">
              {renderBands(bands.daylight, "daylight", startTimeMs, endTimeMs)}
            </div>
          )}
          <div className="timeline-lane timeline-lane-tack">
            {renderBands(bands.tack, "tack", startTimeMs, endTimeMs)}
            {renderBands(bands.gaps, "gap", startTimeMs, endTimeMs)}
          </div>
        </div>

        <input
          className="race-time-slider"
          type="range"
          min={0}
          max={durationSeconds}
          step={1}
          value={currentOffsetSeconds}
          onChange={(event) => handleOffsetChange(Number(event.target.value))}
        />
      </div>

      <div className="timeline-legend">
        <LegendItem className="timeline-band-tack-port" label="Port" />
        <LegendItem className="timeline-band-tack-starboard" label="Starboard" />
        {bands.daylight.length > 0 && (
          <>
            <LegendItem className="timeline-band-daylight-day" label="Day" />
            <LegendItem className="timeline-band-daylight-twilight" label="Twilight" />
            <LegendItem className="timeline-band-daylight-night" label="Night" />
          </>
        )}
        <LegendItem className="timeline-band-gap-no-video" label="No video" />
        <LegendItem className="timeline-band-gap-no-data" label="No data" />
      </div>

      <div className="timeline-scale">
        <span className="timeline-scale-start">{formatDateTime(startTimeMs)}</span>
        <span className="timeline-scale-current">{formatDuration(currentOffsetSeconds)}</span>
        <span className="timeline-scale-end">{formatDateTime(endTimeMs)}</span>
      </div>
    </section>
  );
}

function renderBands<Kind extends string>(
  bands: TimelineBand<Kind>[],
  lane: string,
  startTimeMs: number,
  endTimeMs: number,
) {
  const spanMs = Math.max(1, endTimeMs - startTimeMs);

  return bands.map((band) => (
    <div
      key={`${lane}-${band.kind}-${band.startMs}`}
      className={`timeline-band timeline-band-${lane}-${band.kind}`}
      style={{
        left: `${((band.startMs - startTimeMs) / spanMs) * 100}%`,
        width: `${((band.endMs - band.startMs) / spanMs) * 100}%`,
      }}
    />
  ));
}

function LegendItem({ className, label }: { className: string; label: string }) {
  return (
    <span className="timeline-legend-item">
      <span className={`timeline-legend-swatch ${className}`} />
      {label}
    </span>
  );
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper);
}

function formatDuration(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${days}d ${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}