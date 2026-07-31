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
  return (
    <section className="timeline-controls">
      <div className="timeline-row">
        <button className="primary-button" onClick={() => onPlayingChange(!isPlaying)}>
          {isPlaying ? "Pause" : "Play"}
        </button>

        <button onClick={() => onRaceTimeChange(Math.max(startTimeMs, currentRaceTimeMs - 10_000))}>
          -10s
        </button>

        <button onClick={() => onRaceTimeChange(Math.min(endTimeMs, currentRaceTimeMs + 10_000))}>
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
        min={startTimeMs}
        max={endTimeMs}
        step={1000}
        value={Math.round(currentRaceTimeMs)}
        onChange={(event) => onRaceTimeChange(Number(event.target.value))}
      />
    </section>
  );
}

function formatDateTime(timeMs: number): string {
  return new Date(timeMs).toISOString().replace("T", " ").replace(".000Z", " UTC");
}
