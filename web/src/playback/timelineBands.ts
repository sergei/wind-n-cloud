import { findIndexAtOrBefore, getTackFromTwa, type Tack } from "../data/windSamples";
import type { VideoSegment, WindSamplesColumnar } from "../types/race";
import { classifyDaylight, getSunElevationDeg, type Daylight } from "../utils/sunPosition";

export type TimelineBand<Kind extends string> = {
  startMs: number;
  endMs: number;
  kind: Kind;
};

export type TimelineGap = "no-video" | "no-data";

export type TimelineBands = {
  tack: TimelineBand<Tack | "unknown">[];
  daylight: TimelineBand<Daylight>[];
  gaps: TimelineBand<TimelineGap>[];
};

// Tack runs shorter than this are folded into the preceding run so that brief
// TWA wobbles (head to wind, wind shadow) don't speckle the slider.
const MIN_TACK_RUN_MS = 20_000;
const DAYLIGHT_STEP_MS = 60_000;
const MIN_DATA_GAP_MS = 60_000;
const DATA_GAP_SPACING_FACTOR = 5;

export function buildTimelineBands(
  samples: WindSamplesColumnar,
  segments: VideoSegment[],
  startMs: number,
  endMs: number,
): TimelineBands {
  return {
    tack: clipBands(buildTackBands(samples), startMs, endMs),
    daylight: buildDaylightBands(samples, startMs, endMs),
    gaps: [
      ...findVideoGaps(segments, startMs, endMs),
      ...clipBands(findDataGaps(samples, startMs, endMs), startMs, endMs),
    ],
  };
}

function buildTackBands(samples: WindSamplesColumnar): TimelineBand<Tack | "unknown">[] {
  const { timeMs } = samples;
  const runs: TimelineBand<Tack | "unknown">[] = [];

  for (let index = 0; index < timeMs.length; index += 1) {
    const twa = samples.twa?.[index];
    const kind = twa === null || twa === undefined ? "unknown" : getTackFromTwa(twa);
    const nextTimeMs = timeMs[index + 1] ?? timeMs[index];
    const lastRun = runs[runs.length - 1];

    if (lastRun && lastRun.kind === kind) {
      lastRun.endMs = nextTimeMs;
    } else {
      runs.push({ startMs: timeMs[index], endMs: nextTimeMs, kind });
    }
  }

  const merged: TimelineBand<Tack | "unknown">[] = [];

  for (const run of runs) {
    const previous = merged[merged.length - 1];

    if (previous && (previous.kind === run.kind || run.endMs - run.startMs < MIN_TACK_RUN_MS)) {
      previous.endMs = run.endMs;
    } else {
      merged.push({ ...run });
    }
  }

  return merged;
}

function buildDaylightBands(
  samples: WindSamplesColumnar,
  startMs: number,
  endMs: number,
): TimelineBand<Daylight>[] {
  const fixIndices = buildFixIndices(samples);

  if (!fixIndices) {
    return [];
  }

  const bands: TimelineBand<Daylight>[] = [];

  for (let timeMs = startMs; timeMs < endMs; timeMs += DAYLIGHT_STEP_MS) {
    const sampleIndex = Math.max(0, findIndexAtOrBefore(samples.timeMs, timeMs));
    const fixIndex = fixIndices[sampleIndex];
    const kind = classifyDaylight(
      getSunElevationDeg(timeMs, samples.lat![fixIndex]!, samples.lon![fixIndex]!),
    );
    const stepEndMs = Math.min(endMs, timeMs + DAYLIGHT_STEP_MS);
    const lastBand = bands[bands.length - 1];

    if (lastBand && lastBand.kind === kind) {
      lastBand.endMs = stepEndMs;
    } else {
      bands.push({ startMs: timeMs, endMs: stepEndMs, kind });
    }
  }

  return bands;
}

// For each sample, the index of the latest sample at or before it with a valid
// position fix (or the first fix, for samples before any fix). Null when the
// dataset has no positions at all.
function buildFixIndices(samples: WindSamplesColumnar): number[] | null {
  const { lat, lon } = samples;

  if (!lat || !lon) {
    return null;
  }

  const hasFix = (index: number) =>
    typeof lat[index] === "number" && typeof lon[index] === "number";
  const firstFix = samples.timeMs.findIndex((_, index) => hasFix(index));

  if (firstFix < 0) {
    return null;
  }

  let lastFix = firstFix;
  return samples.timeMs.map((_, index) => {
    if (hasFix(index)) {
      lastFix = index;
    }

    return lastFix;
  });
}

function findVideoGaps(
  segments: VideoSegment[],
  startMs: number,
  endMs: number,
): TimelineBand<TimelineGap>[] {
  const sorted = [...segments].sort((a, b) => a.startTimeMs - b.startTimeMs);
  const gaps: TimelineBand<TimelineGap>[] = [];
  let coveredUntilMs = startMs;

  for (const segment of sorted) {
    if (segment.startTimeMs > coveredUntilMs) {
      gaps.push({
        startMs: coveredUntilMs,
        endMs: Math.min(segment.startTimeMs, endMs),
        kind: "no-video",
      });
    }

    coveredUntilMs = Math.max(coveredUntilMs, segment.endTimeMs);
  }

  if (coveredUntilMs < endMs) {
    gaps.push({ startMs: coveredUntilMs, endMs, kind: "no-video" });
  }

  return gaps.filter((gap) => gap.endMs > gap.startMs);
}

function findDataGaps(
  samples: WindSamplesColumnar,
  startMs: number,
  endMs: number,
): TimelineBand<TimelineGap>[] {
  const { timeMs } = samples;

  if (timeMs.length === 0) {
    return [{ startMs, endMs, kind: "no-data" }];
  }

  const thresholdMs = Math.max(
    MIN_DATA_GAP_MS,
    DATA_GAP_SPACING_FACTOR * medianSpacingMs(timeMs),
  );
  const gaps: TimelineBand<TimelineGap>[] = [];
  const addGap = (gapStartMs: number, gapEndMs: number) => {
    const lastGap = gaps[gaps.length - 1];

    if (lastGap && lastGap.endMs >= gapStartMs) {
      lastGap.endMs = Math.max(lastGap.endMs, gapEndMs);
    } else {
      gaps.push({ startMs: gapStartMs, endMs: gapEndMs, kind: "no-data" });
    }
  };

  if (timeMs[0] - startMs > thresholdMs) {
    addGap(startMs, timeMs[0]);
  }

  for (let index = 0; index < timeMs.length; index += 1) {
    const nextTimeMs = timeMs[index + 1];
    const hasWind = samples.twd[index] !== null || (samples.twa?.[index] ?? null) !== null;

    if (!hasWind) {
      addGap(timeMs[index], nextTimeMs ?? timeMs[index]);
    } else if (nextTimeMs !== undefined && nextTimeMs - timeMs[index] > thresholdMs) {
      addGap(timeMs[index], nextTimeMs);
    }
  }

  if (endMs - timeMs[timeMs.length - 1] > thresholdMs) {
    addGap(timeMs[timeMs.length - 1], endMs);
  }

  return gaps;
}

function medianSpacingMs(timeMs: number[]): number {
  if (timeMs.length < 2) {
    return 0;
  }

  const spacings = timeMs.slice(1).map((value, index) => value - timeMs[index]);
  spacings.sort((a, b) => a - b);
  return spacings[Math.floor(spacings.length / 2)];
}

function clipBands<Kind extends string>(
  bands: TimelineBand<Kind>[],
  startMs: number,
  endMs: number,
): TimelineBand<Kind>[] {
  return bands
    .map((band) => ({
      ...band,
      startMs: Math.max(band.startMs, startMs),
      endMs: Math.min(band.endMs, endMs),
    }))
    .filter((band) => band.endMs > band.startMs);
}
