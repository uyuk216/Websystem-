export type AgeCheck =
  | { ok: true; adultFrom: string }
  | { ok: false; reason: 'under13' | 'invalid' };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Last day of the given month (month is 1-12), accounting for leap years. */
function daysInMonth(year: number, month: number): number {
  // Date.UTC maps years 0-99 to 1900-1999, so set the full year explicitly.
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

/**
 * Checks a birth date (YYYY-MM-DD) against the 13+ rule using calendar dates in UTC.
 * `adultFrom` is the year-month in which the person turns 18.
 */
export function checkAge(birthDate: string, today: Date): AgeCheck {
  const match = DATE_PATTERN.exec(birthDate);
  if (!match) return { ok: false, reason: 'invalid' };

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return { ok: false, reason: 'invalid' };
  }

  const todayYear = today.getUTCFullYear();
  const todayMonth = today.getUTCMonth() + 1;
  const todayDay = today.getUTCDate();

  // Compare as YYYYMMDD integers; zero-padded fields keep lexical and numeric order aligned.
  const birthKey = year * 10000 + month * 100 + day;
  const todayKey = todayYear * 10000 + todayMonth * 100 + todayDay;
  if (birthKey > todayKey) return { ok: false, reason: 'invalid' };

  // The 13th birthday falls on the same month/day, clamped to month end for Feb 29 in non-leap years.
  const thirteenthDay = Math.min(day, daysInMonth(year + 13, month));
  const thirteenthKey = (year + 13) * 10000 + month * 100 + thirteenthDay;
  if (todayKey < thirteenthKey) return { ok: false, reason: 'under13' };

  const adultYear = year + 18;
  return { ok: true, adultFrom: `${String(adultYear).padStart(4, '0')}-${String(month).padStart(2, '0')}` };
}
