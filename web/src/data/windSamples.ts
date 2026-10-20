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

export function findIndexAtOrBefore(timeMs: number[], targetTimeMs: number): number {
  let low = 0;
  let high = timeMs.length - 1;
  let result = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);

    if (timeMs[mid] <= targetTimeMs) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}

export type SmoothedWind = {
  twd: Array<number | null>;
  tws: Array<number | null>;
};

// Zero-lag smoothing: a first-order exponential filter with the given time
// constant is run forward and then backward over the samples, giving a
// symmetric exponential weighting around each point. TWD is filtered as a unit
// vector so it wraps cleanly at 0/360. The filter restarts after gaps longer
// than the time constant.
export function smoothWindSamples(
  samples: WindSamplesColumnar,
  timeConstantSeconds: number,
): SmoothedWind {
  const timeConstantMs = timeConstantSeconds * 1000;
  const { timeMs } = samples;

  const tws = filterForwardBackward(timeMs, samples.tws, timeConstantMs);

  const sine = samples.twd.map((value) =>
    value === null || value === undefined ? null : Math.sin((value * Math.PI) / 180),
  );
  const cosine = samples.twd.map((value) =>
    value === null || value === undefined ? null : Math.cos((value * Math.PI) / 180),
  );
  const sineSmooth = filterForwardBackward(timeMs, sine, timeConstantMs);
  const cosineSmooth = filterForwardBackward(timeMs, cosine, timeConstantMs);

  const twd = sineSmooth.map((sineValue, index) => {
    const cosineValue = cosineSmooth[index];

    if (sineValue === null || cosineValue === null) {
      return null;
    }

    const degrees = (Math.atan2(sineValue, cosineValue) * 180) / Math.PI;
    return ((degrees % 360) + 360) % 360;
  });

  return { twd, tws };
}

function filterForwardBackward(
  timeMs: number[],
  values: Array<number | null>,
  timeConstantMs: number,
): Array<number | null> {
  const forward = filterOnePass(timeMs, values, timeConstantMs, 1);
  return filterOnePass(timeMs, forward, timeConstantMs, -1);
}

function filterOnePass(
  timeMs: number[],
  values: Array<number | null>,
  timeConstantMs: number,
  direction: 1 | -1,
): Array<number | null> {
  const output: Array<number | null> = new Array(values.length).fill(null);
  let state: number | null = null;
  let stateTimeMs = 0;

  const first = direction === 1 ? 0 : values.length - 1;

  for (let index = first; index >= 0 && index < values.length; index += direction) {
    const sampleTimeMs = timeMs[index];
    const value = values[index];

    if (value !== null && value !== undefined) {
      const elapsedMs = Math.abs(sampleTimeMs - stateTimeMs);

      if (state === null || elapsedMs > timeConstantMs) {
        state = value;
      } else {
        state += (value - state) * (1 - Math.exp(-elapsedMs / timeConstantMs));
      }

      stateTimeMs = sampleTimeMs;
    }

    if (state !== null && Math.abs(sampleTimeMs - stateTimeMs) <= timeConstantMs) {
      output[index] = state;
    }
  }

  return output;
}
