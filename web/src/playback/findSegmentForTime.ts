import type { VideoSegment } from "../types/race";

export function findSegmentForTime(
  segments: VideoSegment[],
  raceTimeMs: number,
): VideoSegment | null {
  return (
    segments.find(
      (segment) => raceTimeMs >= segment.startTimeMs && raceTimeMs <= segment.endTimeMs,
    ) ?? null
  );
}

export function findNextSegment(
  segments: VideoSegment[],
  currentSegment: VideoSegment,
): VideoSegment | null {
  const currentIndex = segments.findIndex((segment) => segment.id === currentSegment.id);

  if (currentIndex < 0) {
    return null;
  }

  return segments[currentIndex + 1] ?? null;
}
