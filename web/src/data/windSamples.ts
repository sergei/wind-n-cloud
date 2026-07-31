import type { WindSampleAtTime, WindSamplesColumnar } from "../types/race";

export function findNearestWindSample(
  samples: WindSamplesColumnar,
  raceTimeMs: number,
): WindSampleAtTime | null {
  if (samples.count === 0) {
    return null;
  }

  let low = 0;
  let high = samples.timeMs.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const midTime = samples.timeMs[mid];

    if (midTime === raceTimeMs) {
      return sampleAt(samples, mid);
    }

    if (midTime < raceTimeMs) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const beforeIndex = Math.max(0, high);
  const afterIndex = Math.min(samples.timeMs.length - 1, low);

  const beforeDelta = Math.abs(samples.timeMs[beforeIndex] - raceTimeMs);
  const afterDelta = Math.abs(samples.timeMs[afterIndex] - raceTimeMs);

  return sampleAt(samples, beforeDelta <= afterDelta ? beforeIndex : afterIndex);
}

function sampleAt(samples: WindSamplesColumnar, index: number): WindSampleAtTime {
  return {
    timeMs: samples.timeMs[index],
    twd: samples.twd[index] ?? null,
    tws: samples.tws[index] ?? null,
    heading: samples.heading?.[index] ?? null,
    twa: samples.twa?.[index] ?? null,
  };
}
