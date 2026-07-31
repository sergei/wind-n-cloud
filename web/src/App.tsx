import { useEffect, useMemo, useState } from "react";
import { RaceVideoPanel } from "./components/RaceVideoPanel";
import { TimelineControls } from "./components/TimelineControls";
import { WindHistoryPanel } from "./components/WindHistoryPanel";
import { loadRaceDataset, type LoadedRaceDataset } from "./data/loadRaceDataset";
import { getManifestUrl } from "./data/url";
import { findNearestWindSample } from "./data/windSamples";

export function App() {
  const [dataset, setDataset] = useState<LoadedRaceDataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentRaceTimeMs, setCurrentRaceTimeMs] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [historyDurationMinutes, setHistoryDurationMinutes] = useState(60);

  useEffect(() => {
    const manifestUrl = getManifestUrl();

    loadRaceDataset(manifestUrl)
      .then((loadedDataset) => {
        setDataset(loadedDataset);
        setCurrentRaceTimeMs(loadedDataset.manifest.startTimeMs);
        setHistoryDurationMinutes(
          loadedDataset.manifest.defaults.windHistoryDurationMinutes,
        );
      })
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
  }, []);

  const currentSample = useMemo(() => {
    if (!dataset || currentRaceTimeMs === null) {
      return null;
    }

    return findNearestWindSample(dataset.windSamples, currentRaceTimeMs);
  }, [currentRaceTimeMs, dataset]);

  if (error) {
    return (
      <main className="app-shell">
        <div className="error-state">
          <h1>wind-n-cloud</h1>
          <p>{error}</p>
        </div>
      </main>
    );
  }

  if (!dataset || currentRaceTimeMs === null) {
    return (
      <main className="app-shell">
        <div className="loading-state">
          <h1>wind-n-cloud</h1>
          <p>Loading race dataset…</p>
        </div>
      </main>
    );
  }

  const { manifest, manifestUrl, windSamples } = dataset;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>{manifest.displayName}</h1>
          <p>Cloud video synchronized with wind history</p>
        </div>

        <div className="live-readout">
          <div>
            <span className="readout-label">TWD</span>
            <span className="readout-value">{formatDegrees(currentSample?.twd)}</span>
          </div>
          <div>
            <span className="readout-label">TWS</span>
            <span className="readout-value">{formatSpeed(currentSample?.tws)}</span>
          </div>
          <div>
            <span className="readout-label">HDG</span>
            <span className="readout-value">{formatDegrees(currentSample?.heading)}</span>
          </div>
        </div>
      </header>

      <div className="main-grid">
        <RaceVideoPanel
          manifestUrl={manifestUrl}
          segments={manifest.videoSegments}
          currentRaceTimeMs={currentRaceTimeMs}
          isPlaying={isPlaying}
          onRaceTimeChange={setCurrentRaceTimeMs}
          onPlayingChange={setIsPlaying}
        />

        <WindHistoryPanel
          samples={windSamples}
          currentRaceTimeMs={currentRaceTimeMs}
          historyDurationMinutes={historyDurationMinutes}
        />
      </div>

      <TimelineControls
        startTimeMs={manifest.startTimeMs}
        endTimeMs={manifest.endTimeMs}
        currentRaceTimeMs={currentRaceTimeMs}
        isPlaying={isPlaying}
        historyDurationMinutes={historyDurationMinutes}
        availableHistoryDurationsMinutes={
          manifest.defaults.availableWindHistoryDurationsMinutes
        }
        onRaceTimeChange={(nextRaceTimeMs) => {
          setIsPlaying(false);
          setCurrentRaceTimeMs(nextRaceTimeMs);
        }}
        onPlayingChange={setIsPlaying}
        onHistoryDurationChange={setHistoryDurationMinutes}
      />
    </main>
  );
}

function formatDegrees(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }

  return `${Math.round(value)}°`;
}

function formatSpeed(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }

  return `${value.toFixed(1)} kt`;
}
