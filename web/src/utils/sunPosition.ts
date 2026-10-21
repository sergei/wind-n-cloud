export type Daylight = "day" | "twilight" | "night";

const DEGREES = Math.PI / 180;
const MS_PER_DAY = 86_400_000;
const J2000_MS = Date.UTC(2000, 0, 1, 12);

// Solar elevation from the NOAA approximation; accurate to well under a degree,
// which is plenty for shading day and night on the timeline.
export function getSunElevationDeg(timeMs: number, lat: number, lon: number): number {
  const centuries = (timeMs - J2000_MS) / MS_PER_DAY / 36525;

  const meanLongitude = (280.46646 + centuries * (36000.76983 + centuries * 0.0003032)) % 360;
  const meanAnomaly = 357.52911 + centuries * (35999.05029 - 0.0001537 * centuries);
  const eccentricity = 0.016708634 - centuries * (0.000042037 + 0.0000001267 * centuries);

  const anomalyRad = meanAnomaly * DEGREES;
  const equationOfCenter =
    Math.sin(anomalyRad) * (1.914602 - centuries * (0.004817 + 0.000014 * centuries)) +
    Math.sin(2 * anomalyRad) * (0.019993 - 0.000101 * centuries) +
    Math.sin(3 * anomalyRad) * 0.000289;

  const omega = 125.04 - 1934.136 * centuries;
  const apparentLongitude =
    meanLongitude + equationOfCenter - 0.00569 - 0.00478 * Math.sin(omega * DEGREES);

  const meanObliquity =
    23 + (26 + (21.448 - centuries * (46.815 + centuries * (0.00059 - centuries * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(omega * DEGREES);

  const declination = Math.asin(
    Math.sin(obliquity * DEGREES) * Math.sin(apparentLongitude * DEGREES),
  );

  const y = Math.tan((obliquity * DEGREES) / 2) ** 2;
  const longitudeRad = meanLongitude * DEGREES;
  const equationOfTimeMinutes =
    (4 / DEGREES) *
    (y * Math.sin(2 * longitudeRad) -
      2 * eccentricity * Math.sin(anomalyRad) +
      4 * eccentricity * y * Math.sin(anomalyRad) * Math.cos(2 * longitudeRad) -
      0.5 * y * y * Math.sin(4 * longitudeRad) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * anomalyRad));

  const utcMinutes = (((timeMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) / 60_000;
  const trueSolarMinutes = utcMinutes + equationOfTimeMinutes + 4 * lon;
  const hourAngle = (trueSolarMinutes / 4 - 180) * DEGREES;

  const latRad = lat * DEGREES;
  const cosZenith =
    Math.sin(latRad) * Math.sin(declination) +
    Math.cos(latRad) * Math.cos(declination) * Math.cos(hourAngle);

  return 90 - Math.acos(Math.min(1, Math.max(-1, cosZenith))) / DEGREES;
}

// Sunrise/sunset is at -0.833° (refraction plus the sun's radius); civil
// twilight ends at -6°.
export function classifyDaylight(elevationDeg: number): Daylight {
  if (elevationDeg > -0.833) {
    return "day";
  }

  return elevationDeg > -6 ? "twilight" : "night";
}
