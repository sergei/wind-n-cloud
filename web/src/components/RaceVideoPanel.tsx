import { useEffect, useMemo, useRef } from "react";
import type { VideoSegment } from "../types/race";
import { findNextSegment, findSegmentForTime } from "../playback/findSegmentForTime";
import { resolveRelativeUrl } from "../data/url";

type RaceVideoPanelProps = {
  manifestUrl: string;
  segments: VideoSegment[];
  currentRaceTimeMs: number;
  isPlaying: boolean;
  onRaceTimeChange: (raceTimeMs: number) => void;
  onPlayingChange: (isPlaying: boolean) => void;
};

export function RaceVideoPanel({
  manifestUrl,
  segments,
  currentRaceTimeMs,
  isPlaying,
  onRaceTimeChange,
  onPlayingChange,
}: RaceVideoPanelProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeSegment = useMemo(
    () => findSegmentForTime(segments, currentRaceTimeMs) ?? segments[0] ?? null,
    [segments, currentRaceTimeMs],
  );

  const videoUrl = useMemo(() => {
    if (!activeSegment) {
      return "";
    }

    return resolveRelativeUrl(manifestUrl, activeSegment.videoUrl);
  }, [activeSegment, manifestUrl]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !activeSegment) {
      return;
    }

    const desiredTime = Math.max(
      0,
      Math.min(
        (currentRaceTimeMs - activeSegment.startTimeMs) / 1000,
        (activeSegment.endTimeMs - activeSegment.startTimeMs) / 1000,
      ),
    );

    if (Math.abs(video.currentTime - desiredTime) > 0.5) {
      video.currentTime = desiredTime;
    }
  }, [activeSegment, currentRaceTimeMs, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (isPlaying && video.paused) {
      video.play().catch(() => onPlayingChange(false));
    }

    if (!isPlaying && !video.paused) {
      video.pause();
    }
  }, [isPlaying, onPlayingChange, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !activeSegment) {
      return;
    }

    let animationFrameId: number | null = null;

    const updateRaceTimeFromVideo = () => {
      if (!video.paused && activeSegment) {
        const nextRaceTimeMs = activeSegment.startTimeMs + video.currentTime * 1000;
        onRaceTimeChange(nextRaceTimeMs);
        animationFrameId = requestAnimationFrame(updateRaceTimeFromVideo);
      }
    };

    const handlePlay = () => {
      onPlayingChange(true);
      animationFrameId = requestAnimationFrame(updateRaceTimeFromVideo);
    };

    const handlePause = () => {
      onPlayingChange(false);

      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
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

    const handleSeeked = () => {
      onRaceTimeChange(activeSegment.startTimeMs + video.currentTime * 1000);
    };

    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("ended", handleEnded);
    video.addEventListener("seeked", handleSeeked);

    return () => {
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("ended", handleEnded);
      video.removeEventListener("seeked", handleSeeked);

      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [activeSegment, onPlayingChange, onRaceTimeChange, segments]);

  if (!activeSegment) {
    return (
      <section className="panel video-panel">
        <h2>Cloud video</h2>
        <div className="empty-state">No video segments are available.</div>
      </section>
    );
  }

  return (
    <section className="panel video-panel">
      <div className="panel-header">
        <h2>Cloud video</h2>
      </div>

      <video
        ref={videoRef}
        className="race-video"
        src={videoUrl}
        controls
        playsInline
        preload="metadata"
      />
    </section>
  );
}
