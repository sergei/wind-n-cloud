import { useCallback, useEffect, useMemo, useState } from "react";
import { RaceVideoPanel, type ExpandedVideo } from "./components/RaceVideoPanel";
import { TimelineControls } from "./components/TimelineControls";
import { WindHistoryPanel } from "./components/WindHistoryPanel";
import { loadRaceDataset, type LoadedRaceDataset } from "./data/loadRaceDataset";
import { buildShareUrl, getManifestUrl, getSharedViewState } from "./data/url";
import type { VideoSegment } from "./types/race";
import { formatDateTime } from "./utils/formatDateTime";

const DEBUG_PLAYBACK = false;

export function App() {
  const [dataset, setDataset] = useState<LoadedRaceDataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentRaceTimeMs, setCurrentRaceTimeMs] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [historyDurationMinutes, setHistoryDurationMinutes] = useState(60);
  const [expandedVideo, setExpandedVideo] = useState<ExpandedVideo>(null);

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
        const sharedState = getSharedViewState();
        const defaultRaceTimeMs =
          playbackRange?.startTimeMs ?? loadedDataset.manifest.startTimeMs;
        const initialRaceTimeMs =
          sharedState.raceTimeMs !== undefined && playbackRange
            ? clamp(sharedState.raceTimeMs, playbackRange.startTimeMs, playbackRange.endTimeMs)
            : defaultRaceTimeMs;
        const availableHistoryDurations =
          loadedDataset.manifest.defaults.availableWindHistoryDurationsMinutes;

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
          sharedState.historyDurationMinutes !== undefined &&
            availableHistoryDurations.includes(sharedState.historyDurationMinutes)
            ? sharedState.historyDurationMinutes
            : loadedDataset.manifest.defaults.windHistoryDurationMinutes,
        );
        setExpandedVideo(sharedState.expandedVideo ?? null);
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
        <AppFooter />
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
        <AppFooter />
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
        <AppFooter />
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
          expandedVideo={expandedVideo}
          onRaceTimeChange={(nextRaceTimeMs) =>
            setRaceTimeFromSource("video", nextRaceTimeMs)
          }
          onPlayingChange={(nextIsPlaying) =>
            setPlayingFromSource("video", nextIsPlaying)
          }
          onExpandedVideoChange={setExpandedVideo}
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
        onShare={() =>
          copyToClipboard(
            buildShareUrl({
              raceTimeMs: currentRaceTimeMs,
              historyDurationMinutes,
              expandedVideo,
            }),
          )
        }
      />
      <AppFooter />
    </main>
  );
}

function AppFooter() {
  return (
    <footer className="app-footer">
      <span>&copy; 2026 SunFastCam. All rights reserved.</span>{" "}
      <a href="https://www.youtube.com/@SunFastCam">SunFastCam</a>
    </footer>
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

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // Fallback for non-secure contexts (e.g. dev server opened via LAN IP).
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Copy command was rejected");
    }
  } finally {
    document.body.removeChild(textArea);
  }
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper);
}
