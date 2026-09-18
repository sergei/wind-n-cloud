const PACIFIC_TIMEZONE = "America/Los_Angeles";

const pacificDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PACIFIC_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  hourCycle: "h23",
  timeZoneName: "short",
});

function getPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return parts.find((part) => part.type === type)?.value ?? "";
}

export function formatDateTime(timeMs: number): string {
  const parts = pacificDateTimeFormatter.formatToParts(new Date(timeMs));

  return `${getPart(parts, "year")}-${getPart(parts, "month")}-${getPart(parts, "day")} ${getPart(parts, "hour")}:${getPart(parts, "minute")}:${getPart(parts, "second")} ${getPart(parts, "timeZoneName")}`;
}
