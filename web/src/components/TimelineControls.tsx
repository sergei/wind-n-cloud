const DEBUG_PLAYBACK = false;

type TimelineControlsProps = {
  startTimeMs: number;
  endTimeMs: number;
  currentRaceTimeMs: number;
  isPlaying: boolean;
  historyDurationMinutes: number;
  availableHistoryDurationsMinutes: number[];
  onRaceTimeChange: (raceTimeMs: number) => void;
  onPlayingChange: (isPlaying: boolean) => void;
  onHistoryDurationChange: (durationMinutes: number) => void;
};

export function TimelineControls({
  startTimeMs,
  endTimeMs,
  currentRaceTimeMs,
  isPlaying,
  historyDurationMinutes,
  availableHistoryDurationsMinutes,
  onRaceTimeChange,
  onPlayingChange,
  onHistoryDurationChange,
}: TimelineControlsProps) {
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

        <div className="current-time-display">{formatDateTime(currentRaceTimeMs)}</div>
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

      <div className="timeline-scale">
        <span className="timeline-scale-start">{formatDateTime(startTimeMs)}</span>
        <span className="timeline-scale-current">{formatDuration(currentOffsetSeconds)}</span>
        <span className="timeline-scale-end">{formatDateTime(endTimeMs)}</span>
      </div>
    </section>
  );
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper);
}

function formatDateTime(timeMs: number): string {
  return new Date(timeMs).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}