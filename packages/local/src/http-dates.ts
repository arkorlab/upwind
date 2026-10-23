/**
 * An HTTP-date, read as the edge reads one for a condition on a file (`httpDateMs` in the edge),
 * mirrored here rather than called: the edge's reader sits in a module of the Workers runtime's. The
 * three forms RFC 9110 gives (§5.6.7), each read whole, and a date only where its fields name one —
 * one of the twelve months, a day that month has, a time of day, and the day of the week that date
 * fell on, as its form names it.
 */

const MONTHS: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
/** The days of the week as IMF-fixdate and asctime name them, in `getUTCDay` order. */
const WEEKDAYS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** And as the RFC 850 form names them. */
const RFC_850_WEEKDAYS: readonly string[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** IMF-fixdate, the form every sender generates: `Sun, 06 Nov 1994 08:49:37 GMT`. */
const IMF_FIXDATE =
  /^(?<weekday>[A-Z][a-z]{2}), (?<day>\d{2}) (?<month>[A-Z][a-z]{2}) (?<year>\d{4}) (?<time>\d{2}:\d{2}:\d{2}) GMT$/u;
/** The obsolete RFC 850 form, which a recipient still accepts: `Sunday, 06-Nov-94 08:49:37 GMT`. */
const RFC_850_DATE =
  /^(?<weekday>[A-Z][a-z]{5,8}), (?<day>\d{2})-(?<month>[A-Z][a-z]{2})-(?<year>\d{2}) (?<time>\d{2}:\d{2}:\d{2}) GMT$/u;
/** The obsolete asctime form, in GMT though it names no zone: `Sun Nov  6 08:49:37 1994`. */
const ASCTIME_DATE =
  /^(?<weekday>[A-Z][a-z]{2}) (?<month>[A-Z][a-z]{2}) (?<day>[ \d]\d) (?<time>\d{2}:\d{2}:\d{2}) (?<year>\d{4})$/u;

const HTTP_DATE_FORMS: readonly {
  readonly form: RegExp;
  readonly weekdays: readonly string[];
}[] = [
  { form: IMF_FIXDATE, weekdays: WEEKDAYS },
  { form: RFC_850_DATE, weekdays: RFC_850_WEEKDAYS },
  { form: ASCTIME_DATE, weekdays: WEEKDAYS },
];

const LAST_HOUR = 23;
const LAST_MINUTE = 59;
/** The second `23:59:60` names: the one leap second an HTTP-date's grammar allows. */
const LEAP_SECOND = 60;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MS_PER_SECOND = 1000;
const YEARS_PER_CENTURY = 100;
/** How far ahead of this year an RFC 850 date's two-digit year is read, at most. */
const MOST_YEARS_AHEAD = 50;

/**
 * A year as an HTTP-date writes it: four digits, or the RFC 850 form's two, read in this century
 * unless the date would then be more than fifty years ahead of now, and in the last otherwise.
 */
function fullYear(digits: string, month: number, day: number, seconds: number): number {
  const year = Number(digits);
  if (digits.length !== 2) {
    return year;
  }
  const latest = new Date();
  const thisYear = latest.getUTCFullYear();
  latest.setUTCFullYear(thisYear + MOST_YEARS_AHEAD);
  const read = thisYear - (thisYear % YEARS_PER_CENTURY) + year;
  const instant = Date.UTC(read, month, day) + seconds * MS_PER_SECOND;
  return instant > latest.getTime() ? read - YEARS_PER_CENTURY : read;
}

/** The seconds into its day `HH:MM:SS` names, where it is a time of day: `23:59:60` included. */
function secondsOfDay(time: string): number | undefined {
  const [hour = 0, minute = 0, second = 0] = time.split(':').map(Number);
  const leap = hour === LAST_HOUR && minute === LAST_MINUTE && second === LEAP_SECOND;
  return hour <= LAST_HOUR && minute <= LAST_MINUTE && (leap || second < LEAP_SECOND)
    ? (hour * MINUTES_PER_HOUR + minute) * SECONDS_PER_MINUTE + second
    : undefined;
}

/** The instant an HTTP-date's fields name, where they name one, read back off `Date.UTC`'s date. */
function instantOfFields(
  fields: Readonly<Record<string, string | undefined>>,
  weekdays: readonly string[],
): number | undefined {
  const month = MONTHS.indexOf(fields['month'] ?? '');
  const day = Number(fields['day']);
  const seconds = secondsOfDay(fields['time'] ?? '');
  if (month === -1 || seconds === undefined) {
    return undefined;
  }
  const year = fullYear(fields['year'] ?? '', month, day, seconds);
  const date = new Date(Date.UTC(year, month, day));
  const named =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month &&
    date.getUTCDate() === day &&
    weekdays[date.getUTCDay()] === fields['weekday'];
  return named ? date.getTime() + seconds * MS_PER_SECOND : undefined;
}

/**
 * The instant an HTTP-date names, in any of its three forms, read whole; `undefined` for a value
 * that is none, which a condition on it is then not judged by.
 */
export function httpDateMs(value: string): number | undefined {
  for (const { form, weekdays } of HTTP_DATE_FORMS) {
    const fields = form.exec(value)?.groups;
    if (fields !== undefined) {
      return instantOfFields(fields, weekdays);
    }
  }
  return undefined;
}
