const fixedIsoDurationPattern =
  /^P(?!$)(\d{1,7}W)?(\d{1,7}D)?(T(?!$)(\d{1,7}H)?(\d{1,7}M)?(\d{1,7}S)?)?$/;

// Four-digit ISO date-time anchors plus this bound stay inside both the JS Date
// range and PostgreSQL's timestamp range. The parser is the admission owner;
// downstream runtimes never approximate or clamp an accepted duration.
const MAX_FIXED_DURATION_MS = 8_000_000_000_000_000;

/** Milliseconds in a fixed ISO-8601 duration, or null for invalid/calendar units. */
export function fixedIsoDurationMs(duration: string): number | null {
  const match = fixedIsoDurationPattern.exec(duration);
  if (!match) return null;
  const [, weeks, days, , hours, minutes, seconds] = match;
  const integer = (part: string | undefined): number =>
    part ? Number.parseInt(part, 10) : 0;
  const milliseconds =
    integer(weeks) * 604_800_000 +
    integer(days) * 86_400_000 +
    integer(hours) * 3_600_000 +
    integer(minutes) * 60_000 +
    integer(seconds) * 1_000;
  return Number.isSafeInteger(milliseconds) &&
    milliseconds <= MAX_FIXED_DURATION_MS
    ? milliseconds
    : null;
}
