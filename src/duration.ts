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

const calendarPeriodPattern =
  /^P(?!$)(?:(\d{1,4})Y)?(?:(\d{1,4})M)?(?:(\d{1,4})W)?(?:(\d{1,5})D)?(?:T(?!$)(?:(\d{1,6})H)?(?:(\d{1,7})M)?(?:(\d{1,7})S)?)?$/;

/**
 * An ISO-8601 period as whole calendar months plus fixed milliseconds, or
 * null. `P1M` is one month, `P1Y` twelve, `P2W` fourteen days. A zero period
 * never advances, so it is refused.
 */
export function calendarPeriod(
  period: string,
): { months: number; milliseconds: number } | null {
  const match = calendarPeriodPattern.exec(period);
  if (!match) return null;
  const [, years, months, weeks, days, hours, minutes, seconds] = match.map(
    (part) => (part ? Number.parseInt(part, 10) : 0),
  ) as number[];
  const result = {
    months: years! * 12 + months!,
    milliseconds:
      weeks! * 604_800_000 +
      days! * 86_400_000 +
      hours! * 3_600_000 +
      minutes! * 60_000 +
      seconds! * 1_000,
  };
  return result.months + result.milliseconds > 0 ? result : null;
}

/**
 * `times` periods after `anchor`, in epoch milliseconds. Months are added to
 * the anchor's calendar date in UTC and the day clamps to the month's end, so
 * pieces keep the anchor's day instead of drifting after a short month.
 */
export function stepDate(
  anchor: number,
  period: { months: number; milliseconds: number },
  times: number,
): number {
  const date = new Date(anchor);
  const day = date.getUTCDate();
  const months = date.getUTCMonth() + period.months * times;
  const last = new Date(
    Date.UTC(date.getUTCFullYear(), months + 1, 0),
  ).getUTCDate();
  const shifted = Date.UTC(
    date.getUTCFullYear(),
    months,
    Math.min(day, last),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  );
  return shifted + period.milliseconds * times;
}
