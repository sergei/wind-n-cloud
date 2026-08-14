import { useCallback, useEffect, useMemo, useState } from "react";
import { RaceVideoPanel } from "./components/RaceVideoPanel";
import { TimelineControls } from "./components/TimelineControls";
import { WindHistoryPanel } from "./components/WindHistoryPanel";
import { loadRaceDataset, type LoadedRaceDataset } from "./data/loadRaceDataset";
import { getManifestUrl } from "./data/url";
import type { VideoSegment } from "./types/race";

const DEBUG_PLAYBACK = false;

export function App() {
  const [dataset, setDataset] = useState<LoadedRaceDataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentRaceTimeMs, setCurrentRaceTimeMs] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [historyDurationMinutes, setHistoryDurationMinutes] = useState(60);

  const setRaceTimeFromSource = useCallback(
    (source: string, nextRaceTimeMs: number) => {
      if (DEBUG_PLAYBACK) {
        console.log("[App] setRaceTime", {
          source,
          nextRaceTimeMs,
          nextIso: formatDateTime(nextRaceTimeMs),
        });
      }

      setCurrentRaceTimeMs(nextRaceTimeMs);
    },
    [],
  );

  const setPlayingFromSource = useCallback((source: string, nextIsPlaying: boolean) => {
    if (DEBUG_PLAYBACK) {
      console.log("[App] setPlaying", {
        source,
        nextIsPlaying,
      });
    }

    setIsPlaying(nextIsPlaying);
  }, []);

  useEffect(() => {
    const manifestUrl = getManifestUrl();

    loadRaceDataset(manifestUrl)
      .then((loadedDataset) => {
        const playbackRange = getPlaybackRange(loadedDataset.manifest.videoSegments);
        const initialRaceTimeMs =
          playbackRange?.startTimeMs ?? loadedDataset.manifest.startTimeMs;

        if (DEBUG_PLAYBACK) {
          console.log("[App] dataset loaded", {
            manifestUrl,
            manifestStart: formatDateTime(loadedDataset.manifest.startTimeMs),
            manifestEnd: formatDateTime(loadedDataset.manifest.endTimeMs),
            playbackStart: playbackRange
              ? formatDateTime(playbackRange.startTimeMs)
              : null,
            playbackEnd: playbackRange ? formatDateTime(playbackRange.endTimeMs) : null,
            segmentCount: loadedDataset.manifest.videoSegments.length,
            firstSegments: loadedDataset.manifest.videoSegments.slice(0, 5),
          });
        }

        setDataset(loadedDataset);
        setCurrentRaceTimeMs(initialRaceTimeMs);
        setHistoryDurationMinutes(
          loadedDataset.manifest.defaults.windHistoryDurationMinutes,
        );
      })
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
  }, []);

  const playbackRange = useMemo(() => {
    if (!dataset) {
      return null;
    }

    return getPlaybackRange(dataset.manifest.videoSegments);
  }, [dataset]);

  useEffect(() => {
    if (!DEBUG_PLAYBACK || currentRaceTimeMs === null) {
      return;
    }

    console.log("[App] currentRaceTimeMs committed", {
      currentRaceTimeMs,
      iso: formatDateTime(currentRaceTimeMs),
      isPlaying,
    });
  }, [currentRaceTimeMs, isPlaying]);

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

  if (!playbackRange) {
    return (
      <main className="app-shell">
        <div className="error-state">
          <h1>wind-n-cloud</h1>
          <p>No video segments are available in the manifest.</p>
        </div>
      </main>
    );
  }

  const { manifest, manifestUrl, windSamples } = dataset;

  return (
    <main className="app-shell">
      <div className="main-grid">
        <RaceVideoPanel
          raceName={manifest.displayName}
          manifestUrl={manifestUrl}
          segments={manifest.videoSegments}
          currentRaceTimeMs={currentRaceTimeMs}
          isPlaying={isPlaying}
          onRaceTimeChange={(nextRaceTimeMs) =>
            setRaceTimeFromSource("video", nextRaceTimeMs)
          }
          onPlayingChange={(nextIsPlaying) =>
            setPlayingFromSource("video", nextIsPlaying)
          }
        />

        <WindHistoryPanel
          samples={windSamples}
          currentRaceTimeMs={currentRaceTimeMs}
          historyDurationMinutes={historyDurationMinutes}
        />
      </div>

      <TimelineControls
        startTimeMs={playbackRange.startTimeMs}
        endTimeMs={playbackRange.endTimeMs}
        currentRaceTimeMs={clamp(
          currentRaceTimeMs,
          playbackRange.startTimeMs,
          playbackRange.endTimeMs,
        )}
        isPlaying={isPlaying}
        historyDurationMinutes={historyDurationMinutes}
        availableHistoryDurationsMinutes={
          manifest.defaults.availableWindHistoryDurationsMinutes
        }
        onRaceTimeChange={(nextRaceTimeMs) => {
          setPlayingFromSource("timeline", false);
          setRaceTimeFromSource(
            "timeline",
            clamp(nextRaceTimeMs, playbackRange.startTimeMs, playbackRange.endTimeMs),
          );
        }}
        onPlayingChange={(nextIsPlaying) =>
          setPlayingFromSource("timeline", nextIsPlaying)
        }
        onHistoryDurationChange={setHistoryDurationMinutes}
      />
    </main>
  );
}

function getPlaybackRange(
  videoSegments: VideoSegment[],
): { startTimeMs: number; endTimeMs: number } | null {
  if (videoSegments.length === 0) {
    return null;
  }

  const startTimeMs = Math.min(
    ...videoSegments.map((segment) => segment.startTimeMs),
  );
  const endTimeMs = Math.max(
    ...videoSegments.map((segment) => segment.endTimeMs),
  );

  return {
    startTimeMs,
    endTimeMs,
  };
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper);
}

function formatDateTime(timeMs: number): string {
  return new Date(timeMs).toISOString().replace("T", " ").replace(".000Z", " UTC");
}
