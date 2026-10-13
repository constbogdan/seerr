const DAY_MS = 86_400_000;
const SQLITE_UTC_DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export type FactualDateValue = string | number | Date;

/**
 * API dates are ISO instants. Normalize a SQLite UTC value defensively so it
 * can never be interpreted as browser-local time if one reaches presentation.
 */
export const parseFactualDate = (value: FactualDateValue): Date =>
  value instanceof Date
    ? new Date(value.getTime())
    : new Date(
        typeof value === 'string' && SQLITE_UTC_DATE.test(value)
          ? `${value.replace(' ', 'T')}Z`
          : value
      );

const localCalendarDay = (value: FactualDateValue): number => {
  const date = parseFactualDate(value);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
};

/**
 * Signed local-calendar-day offset used by react-intl relative formatting.
 */
export const factualRelativeDay = (
  value: FactualDateValue,
  now: FactualDateValue = Date.now()
): number => (localCalendarDay(value) - localCalendarDay(now)) / DAY_MS;

export const factualDaysAgo = (
  value: FactualDateValue,
  now: FactualDateValue = Date.now()
): number => Math.max(0, -factualRelativeDay(value, now));
