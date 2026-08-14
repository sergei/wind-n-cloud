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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const suppressVideoTimeUpdatesRef = useRef(false);
  const lastLoggedVideoSecondRef = useRef<number | null>(null);

  const activeSegment = useMemo(
    () => findBestSegmentForTime(segments, currentRaceTimeMs),
    [segments, currentRaceTimeMs],
  );

  const videoUrl = useMemo(() => {
    if (!activeSegment) {
      return "";
    }

    const baseUrl = activeSegment.videoUrl;
    const panPrefix = `pan-${String(DEFAULT_PAN_ANGLE).padStart(3, "0")}`;
    
    // Replace 'video/' with 'video/pan-XXX/' in the URL
    const panUrl = baseUrl.replace(/^video\//, `video/${panPrefix}/`);
    
    return resolveRelativeUrl(getMediaBaseUrl() ?? manifestUrl, panUrl);
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
      videoUrl,
    });
  }, [activeSegment, currentRaceTimeMs, desiredVideoTimeSeconds, isPlaying, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !activeSegment || isPlaying) {
      return;
    }

    let cancelled = false;

    const syncVideoToRaceTime = async () => {
      suppressVideoTimeUpdatesRef.current = true;

      await waitForMetadata(video);

      if (cancelled) {
        return;
      }

      if (Math.abs(video.currentTime - desiredVideoTimeSeconds) > 0.2) {
        if (DEBUG_PLAYBACK) {
          console.log("[RaceVideoPanel] paused seek", {
            fromVideoTime: video.currentTime,
            toVideoTime: desiredVideoTimeSeconds,
            currentRaceTimeMs,
            currentIso: formatDateTime(currentRaceTimeMs),
          });
        }

        video.currentTime = desiredVideoTimeSeconds;
        await waitForSeek(video);
      }

      if (!cancelled) {
        suppressVideoTimeUpdatesRef.current = false;
      }
    };

    void syncVideoToRaceTime();

    return () => {
      cancelled = true;
      suppressVideoTimeUpdatesRef.current = false;
    };
  }, [activeSegment, desiredVideoTimeSeconds, isPlaying, currentRaceTimeMs, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !activeSegment) {
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
        video.paused ||
        !activeSegment ||
        suppressVideoTimeUpdatesRef.current
      ) {
        stopAnimationLoop();
        return;
      }

      const raceOffsetSeconds = videoSecondsToRaceSeconds(
        activeSegment,
        video.currentTime,
      );

      const nextRaceTimeMs =
        activeSegment.startTimeMs + raceOffsetSeconds * 1000;

      const currentWholeVideoSecond = Math.floor(video.currentTime);

      if (DEBUG_PLAYBACK && lastLoggedVideoSecondRef.current !== currentWholeVideoSecond) {
        lastLoggedVideoSecondRef.current = currentWholeVideoSecond;

        console.log("[RaceVideoPanel] playback tick", {
          videoCurrentTime: video.currentTime,
          raceOffsetSeconds,
          raceSecondsPerVideoSecond: getRaceSecondsPerVideoSecond(activeSegment),
          nextRaceTimeMs,
          nextIso: formatDateTime(nextRaceTimeMs),
        });
      }

      onRaceTimeChange(nextRaceTimeMs);

      animationFrameRef.current = requestAnimationFrame(updateRaceTimeFromPlayingVideo);
    };

    const startPlaybackFromCurrentRaceTime = async () => {
      stopAnimationLoop();
      suppressVideoTimeUpdatesRef.current = true;
      lastLoggedVideoSecondRef.current = null;

      await waitForMetadata(video);

      if (cancelled) {
        return;
      }

      if (Math.abs(video.currentTime - desiredVideoTimeSeconds) > 0.2) {
        if (DEBUG_PLAYBACK) {
          console.log("[RaceVideoPanel] play seek before start", {
            fromVideoTime: video.currentTime,
            toVideoTime: desiredVideoTimeSeconds,
            currentRaceTimeMs,
            currentIso: formatDateTime(currentRaceTimeMs),
            raceSecondsPerVideoSecond: getRaceSecondsPerVideoSecond(activeSegment),
          });
        }

        video.currentTime = desiredVideoTimeSeconds;
        await waitForSeek(video);
      }

      if (cancelled) {
        return;
      }

      suppressVideoTimeUpdatesRef.current = false;

      try {
        await video.play();

        if (DEBUG_PLAYBACK) {
          console.log("[RaceVideoPanel] play started", {
            videoCurrentTime: video.currentTime,
            currentRaceTimeMs,
            currentIso: formatDateTime(currentRaceTimeMs),
            raceSecondsPerVideoSecond: getRaceSecondsPerVideoSecond(activeSegment),
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
      video.pause();
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
    videoUrl,
  ]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !activeSegment) {
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

    video.addEventListener("pause", handlePause);
    video.addEventListener("ended", handleEnded);

    return () => {
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("ended", handleEnded);
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

  return (
    <section className="panel video-panel">
      <div className="panel-header">
        <div>
          <h2>{raceName}</h2>
          <div className="panel-subtitle">{getVideoFileName(activeSegment.videoUrl)}</div>
        </div>
      </div>

      <video
        key={activeSegment.id}
        ref={videoRef}
        className="race-video"
        src={videoUrl}
        playsInline
        preload="metadata"
      />
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