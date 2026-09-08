import { useEffect, useMemo, useRef } from "react";
import type { VideoSegment } from "../types/race";
import { findNextSegment } from "../playback/findSegmentForTime";
import { getMediaBaseUrl, resolveRelativeUrl } from "../data/url";

const DEBUG_PLAYBACK = false;
const DEFAULT_PAN_ANGLE = 0;

type RaceVideoPanelProps = {
  raceName: string;
  manifestUrl: string;
  segments: VideoSegment[];
  currentRaceTimeMs: number;
  isPlaying: boolean;
  onRaceTimeChange: (raceTimeMs: number) => void;
  onPlayingChange: (isPlaying: boolean) => void;
};

export function RaceVideoPanel({
  raceName,
  manifestUrl,
  segments,
  currentRaceTimeMs,
  isPlaying,
  onRaceTimeChange,
  onPlayingChange,
}: RaceVideoPanelProps) {
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const satelliteVideoRef = useRef<HTMLVideoElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const suppressVideoTimeUpdatesRef = useRef(false);
  const lastLoggedVideoSecondRef = useRef<number | null>(null);

  const activeSegment = useMemo(
    () => findBestSegmentForTime(segments, currentRaceTimeMs),
    [segments, currentRaceTimeMs],
  );

  const cameraVideoUrl = useMemo(() => {
    if (!activeSegment) {
      return "";
    }

    const baseUrl = activeSegment.videoUrl;
    const panPrefix = `pan-${String(DEFAULT_PAN_ANGLE).padStart(3, "0")}`;

    // Replace 'video/' with 'video/pan-XXX/' in the URL
    const panUrl = baseUrl.replace(/^video\//, `video/${panPrefix}/`);

    return resolveRelativeUrl(getMediaBaseUrl() ?? manifestUrl, panUrl);
  }, [activeSegment, manifestUrl]);

  const satelliteVideoUrl = useMemo(() => {
    if (!activeSegment || !activeSegment.satelliteVideoUrl) {
      return "";
    }

    return resolveRelativeUrl(
      getMediaBaseUrl() ?? manifestUrl,
      activeSegment.satelliteVideoUrl,
    );
  }, [activeSegment, manifestUrl]);

  const desiredVideoTimeSeconds = useMemo(() => {
    if (!activeSegment) {
      return 0;
    }

    const raceOffsetSeconds =
      (currentRaceTimeMs - activeSegment.startTimeMs) / 1000;

    return raceSecondsToVideoSeconds(activeSegment, raceOffsetSeconds);
  }, [activeSegment, currentRaceTimeMs]);

  useEffect(() => {
    if (!DEBUG_PLAYBACK || !activeSegment) {
      return;
    }

    console.log("[RaceVideoPanel] render inputs", {
      currentRaceTimeMs,
      currentIso: formatDateTime(currentRaceTimeMs),
      isPlaying,
      activeSegmentId: activeSegment.id,
      activeSegmentStart: formatDateTime(activeSegment.startTimeMs),
      activeSegmentEnd: formatDateTime(activeSegment.endTimeMs),
      raceDurationSeconds: activeSegment.raceDurationSeconds,
      videoDurationSeconds: activeSegment.videoDurationSeconds,
      raceSecondsPerVideoSecond: getRaceSecondsPerVideoSecond(activeSegment),
      desiredVideoTimeSeconds,
      cameraVideoUrl,
      satelliteVideoUrl,
    });
  }, [
    activeSegment,
    currentRaceTimeMs,
    desiredVideoTimeSeconds,
    isPlaying,
    cameraVideoUrl,
    satelliteVideoUrl,
  ]);

  // Handle paused seek / time synchronization
  useEffect(() => {
    const cameraVideo = cameraVideoRef.current;
    const satelliteVideo = satelliteVideoRef.current;

    if (!cameraVideo || !activeSegment || isPlaying) {
      return;
    }

    let cancelled = false;

    const syncVideosToRaceTime = async () => {
      suppressVideoTimeUpdatesRef.current = true;

      const waitPromises: Promise<void>[] = [waitForMetadata(cameraVideo)];
      if (satelliteVideo && satelliteVideoUrl) {
        waitPromises.push(waitForMetadata(satelliteVideo));
      }

      await Promise.all(waitPromises);

      if (cancelled) {
        return;
      }

      const seekPromises: Promise<void>[] = [];

      if (Math.abs(cameraVideo.currentTime - desiredVideoTimeSeconds) > 0.2) {
        if (DEBUG_PLAYBACK) {
          console.log("[RaceVideoPanel] paused camera seek", {
            fromVideoTime: cameraVideo.currentTime,
            toVideoTime: desiredVideoTimeSeconds,
            currentRaceTimeMs,
          });
        }
        cameraVideo.currentTime = desiredVideoTimeSeconds;
        seekPromises.push(waitForSeek(cameraVideo));
      }

      if (
        satelliteVideo &&
        satelliteVideoUrl &&
        Math.abs(satelliteVideo.currentTime - desiredVideoTimeSeconds) > 0.2
      ) {
        satelliteVideo.currentTime = desiredVideoTimeSeconds;
        seekPromises.push(waitForSeek(satelliteVideo));
      }

      if (seekPromises.length > 0) {
        await Promise.all(seekPromises);
      }

      if (!cancelled) {
        suppressVideoTimeUpdatesRef.current = false;
      }
    };

    void syncVideosToRaceTime();

    return () => {
      cancelled = true;
      suppressVideoTimeUpdatesRef.current = false;
    };
  }, [
    activeSegment,
    desiredVideoTimeSeconds,
    isPlaying,
    currentRaceTimeMs,
    cameraVideoUrl,
    satelliteVideoUrl,
  ]);

  // Handle playback start/stop & continuous animation loop
  useEffect(() => {
    const cameraVideo = cameraVideoRef.current;
    const satelliteVideo = satelliteVideoRef.current;

    if (!cameraVideo || !activeSegment) {
      return;
    }

    let cancelled = false;

    const stopAnimationLoop = () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };

    const updateRaceTimeFromPlayingVideo = () => {
      if (
        cancelled ||
        cameraVideo.paused ||
        !activeSegment ||
        suppressVideoTimeUpdatesRef.current
      ) {
        stopAnimationLoop();
        return;
      }

      const raceOffsetSeconds = videoSecondsToRaceSeconds(
        activeSegment,
        cameraVideo.currentTime,
      );

      const nextRaceTimeMs =
        activeSegment.startTimeMs + raceOffsetSeconds * 1000;

      const currentWholeVideoSecond = Math.floor(cameraVideo.currentTime);

      if (
        DEBUG_PLAYBACK &&
        lastLoggedVideoSecondRef.current !== currentWholeVideoSecond
      ) {
        lastLoggedVideoSecondRef.current = currentWholeVideoSecond;

        console.log("[RaceVideoPanel] playback tick", {
          videoCurrentTime: cameraVideo.currentTime,
          raceOffsetSeconds,
          raceSecondsPerVideoSecond: getRaceSecondsPerVideoSecond(activeSegment),
          nextRaceTimeMs,
          nextIso: formatDateTime(nextRaceTimeMs),
        });
      }

      // Check for satellite video drift during continuous playback
      if (
        satelliteVideo &&
        satelliteVideoUrl &&
        !satelliteVideo.paused &&
        Math.abs(satelliteVideo.currentTime - cameraVideo.currentTime) > 0.3
      ) {
        satelliteVideo.currentTime = cameraVideo.currentTime;
      }

      onRaceTimeChange(nextRaceTimeMs);

      animationFrameRef.current = requestAnimationFrame(
        updateRaceTimeFromPlayingVideo,
      );
    };

    const startPlaybackFromCurrentRaceTime = async () => {
      stopAnimationLoop();
      suppressVideoTimeUpdatesRef.current = true;
      lastLoggedVideoSecondRef.current = null;

      const waitPromises: Promise<void>[] = [waitForMetadata(cameraVideo)];
      if (satelliteVideo && satelliteVideoUrl) {
        waitPromises.push(waitForMetadata(satelliteVideo));
      }

      await Promise.all(waitPromises);

      if (cancelled) {
        return;
      }

      const seekPromises: Promise<void>[] = [];

      if (Math.abs(cameraVideo.currentTime - desiredVideoTimeSeconds) > 0.2) {
        cameraVideo.currentTime = desiredVideoTimeSeconds;
        seekPromises.push(waitForSeek(cameraVideo));
      }

      if (
        satelliteVideo &&
        satelliteVideoUrl &&
        Math.abs(satelliteVideo.currentTime - desiredVideoTimeSeconds) > 0.2
      ) {
        satelliteVideo.currentTime = desiredVideoTimeSeconds;
        seekPromises.push(waitForSeek(satelliteVideo));
      }

      if (seekPromises.length > 0) {
        await Promise.all(seekPromises);
      }

      if (cancelled) {
        return;
      }

      suppressVideoTimeUpdatesRef.current = false;

      try {
        const playPromises: Promise<void>[] = [cameraVideo.play()];
        if (satelliteVideo && satelliteVideoUrl) {
          playPromises.push(satelliteVideo.play());
        }

        await Promise.all(playPromises);

        if (DEBUG_PLAYBACK) {
          console.log("[RaceVideoPanel] play started", {
            cameraCurrentTime: cameraVideo.currentTime,
            currentRaceTimeMs,
          });
        }

        if (!cancelled) {
          animationFrameRef.current = requestAnimationFrame(
            updateRaceTimeFromPlayingVideo,
          );
        }
      } catch (error) {
        console.warn("[RaceVideoPanel] video.play failed", error);
        suppressVideoTimeUpdatesRef.current = false;
        onPlayingChange(false);
      }
    };

    if (isPlaying) {
      void startPlaybackFromCurrentRaceTime();
    } else {
      cameraVideo.pause();
      if (satelliteVideo) {
        satelliteVideo.pause();
      }
      stopAnimationLoop();
      suppressVideoTimeUpdatesRef.current = false;
    }

    return () => {
      cancelled = true;
      stopAnimationLoop();
      suppressVideoTimeUpdatesRef.current = false;
    };
  }, [
    activeSegment,
    desiredVideoTimeSeconds,
    isPlaying,
    onPlayingChange,
    onRaceTimeChange,
    currentRaceTimeMs,
    cameraVideoUrl,
    satelliteVideoUrl,
  ]);

  // Handle video pause and ended events
  useEffect(() => {
    const cameraVideo = cameraVideoRef.current;

    if (!cameraVideo || !activeSegment) {
      return;
    }

    const handlePause = () => {
      if (!suppressVideoTimeUpdatesRef.current) {
        onPlayingChange(false);
      }
    };

    const handleEnded = () => {
      const nextSegment = findNextSegment(segments, activeSegment);

      if (!nextSegment) {
        onPlayingChange(false);
        return;
      }

      onRaceTimeChange(nextSegment.startTimeMs);
    };

    cameraVideo.addEventListener("pause", handlePause);
    cameraVideo.addEventListener("ended", handleEnded);

    return () => {
      cameraVideo.removeEventListener("pause", handlePause);
      cameraVideo.removeEventListener("ended", handleEnded);
    };
  }, [activeSegment, onPlayingChange, onRaceTimeChange, segments]);

  if (!activeSegment) {
    return (
      <section className="panel video-panel">
        <div className="panel-header">
          <div>
            <h2>{raceName}</h2>
            <div className="panel-subtitle">No clip available</div>
          </div>
        </div>
        <div className="empty-state">No video segments are available.</div>
      </section>
    );
  }

  const hasSatelliteVideo = Boolean(satelliteVideoUrl);

  return (
    <section className={`panel video-panel ${hasSatelliteVideo ? "has-dual-video" : ""}`}>
      <div className={`video-grid-container ${hasSatelliteVideo ? "dual-video-grid" : "single-video-grid"}`}>
        <div className="video-card">
          <div className="panel-header video-sub-header">
            <div>
              <h2>{raceName} (Onboard Camera)</h2>
              <div className="panel-subtitle">{getVideoFileName(activeSegment.videoUrl)}</div>
            </div>
          </div>
          <video
            key={`camera-${activeSegment.id}`}
            ref={cameraVideoRef}
            className="race-video"
            src={cameraVideoUrl}
            playsInline
            preload="metadata"
            muted
          />
        </div>

        {hasSatelliteVideo && (
          <div className="video-card">
            <div className="panel-header video-sub-header">
              <div>
                <h2>Satellite &amp; Wind Overlay</h2>
                <div className="panel-subtitle">
                  {getVideoFileName(activeSegment.satelliteVideoUrl ?? "")}
                </div>
              </div>
            </div>
            <video
              key={`satellite-${activeSegment.id}`}
              ref={satelliteVideoRef}
              className="race-video satellite-video"
              src={satelliteVideoUrl}
              playsInline
              preload="metadata"
              muted
            />
          </div>
        )}
      </div>
    </section>
  );
}

function getVideoFileName(videoUrl: string): string {
  return videoUrl.split("/").pop() ?? videoUrl;
}

function findBestSegmentForTime(
  segments: VideoSegment[],
  raceTimeMs: number,
): VideoSegment | null {
  const sortedSegments = [...segments].sort(
    (left, right) => left.startTimeMs - right.startTimeMs,
  );

  if (sortedSegments.length === 0) {
    return null;
  }

  const exactSegment = sortedSegments.find(
    (segment) => raceTimeMs >= segment.startTimeMs && raceTimeMs <= segment.endTimeMs,
  );

  if (exactSegment) {
    return exactSegment;
  }

  let bestSegment = sortedSegments[0];

  for (const segment of sortedSegments) {
    if (segment.startTimeMs <= raceTimeMs) {
      bestSegment = segment;
    } else {
      break;
    }
  }

  return bestSegment;
}

function raceSecondsToVideoSeconds(
  segment: VideoSegment,
  raceOffsetSeconds: number,
): number {
  const raceSecondsPerVideoSecond = getRaceSecondsPerVideoSecond(segment);
  const videoDurationSeconds =
    segment.videoDurationSeconds ?? Number.POSITIVE_INFINITY;

  return clamp(
    raceOffsetSeconds / raceSecondsPerVideoSecond,
    0,
    videoDurationSeconds,
  );
}

function videoSecondsToRaceSeconds(
  segment: VideoSegment,
  videoSeconds: number,
): number {
  const raceSecondsPerVideoSecond = getRaceSecondsPerVideoSecond(segment);
  const raceDurationSeconds =
    segment.raceDurationSeconds ?? Number.POSITIVE_INFINITY;

  return clamp(
    videoSeconds * raceSecondsPerVideoSecond,
    0,
    raceDurationSeconds,
  );
}

function getRaceSecondsPerVideoSecond(segment: VideoSegment): number {
  const value = segment.raceSecondsPerVideoSecond;

  if (value !== undefined && Number.isFinite(value) && value > 0) {
    return value;
  }

  return 1;
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
  });
}

function waitForSeek(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => resolve(), 1000);

    video.addEventListener(
      "seeked",
      () => {
        window.clearTimeout(timeoutId);
        resolve();
      },
      { once: true },
    );
  });
}

function formatDateTime(timeMs: number): string {
  return new Date(timeMs).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper);
}