/**
 * Date math behind the `react-day-picker` stand-in: calendar systems
 * (Gregorian through date-fns, Persian/Jalali by arithmetic conversion),
 * matchers (`disabled`, `hidden`, custom modifiers), and the selection rules
 * for `single`, `multiple`, and `range` modes (mirroring react-day-picker v9).
 */

import {
  addDays,
  addMonths,
  format,
  isAfter,
  isBefore,
  isSameDay,
  type Locale,
  startOfDay,
  startOfMonth,
} from "date-fns";

export interface DateRange {
  from: Date | undefined;
  to?: Date | undefined;
}
export interface DateBefore {
  before: Date;
}
export interface DateAfter {
  after: Date;
}
export interface DateInterval {
  before: Date;
  after: Date;
}
export interface DayOfWeek {
  dayOfWeek: number | number[];
}
export type Matcher =
  | boolean
  | ((date: Date) => boolean)
  | Date
  | Date[]
  | DateRange
  | DateBefore
  | DateAfter
  | DateInterval
  | DayOfWeek;

/** A month/year arithmetic and labeling scheme. */
export interface CalendarSystem {
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  startOfMonth(date: Date): Date;
  addMonths(monthStart: Date, amount: number): Date;
  /** `year * 12 + monthIndex`, for ordering months. */
  monthKey(date: Date): number;
  year(date: Date): number;
  monthIndex(date: Date): number;
  fromYearMonth(year: number, monthIndex: number): Date;
  formatCaption(month: Date, locale?: Locale): string;
  formatDay(date: Date, locale?: Locale): string;
  formatWeekday(date: Date, locale?: Locale): string;
  formatMonth(month: Date, locale?: Locale): string;
  formatYear(year: number): string;
  formatNumber(value: number): string;
}

export const gregorian: CalendarSystem = {
  weekStartsOn: 0,
  startOfMonth: (date) => startOfMonth(date),
  addMonths: (monthStart, amount) => startOfMonth(addMonths(monthStart, amount)),
  monthKey: (date) => date.getFullYear() * 12 + date.getMonth(),
  year: (date) => date.getFullYear(),
  monthIndex: (date) => date.getMonth(),
  fromYearMonth: (year, monthIndex) => new Date(year, monthIndex, 1),
  formatCaption: (month, locale) => format(month, "LLLL y", { locale }),
  formatDay: (date, locale) => format(date, "d", { locale }),
  formatWeekday: (date, locale) => format(date, "cccccc", { locale }),
  formatMonth: (month, locale) => format(month, "LLLL", { locale }),
  formatYear: (year) => String(year),
  formatNumber: (value) => String(value),
};

/** Gregorian (month 1-12) → Jalali [year, month 1-12, day]. */
export function toJalali(gy: number, gm: number, gd: number): [number, number, number] {
  const daysBefore = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days =
    355666 +
    365 * gy +
    Math.floor((gy2 + 3) / 4) -
    Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) +
    gd +
    (daysBefore[gm - 1] ?? 0);
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  if (days < 186) return [jy, 1 + Math.floor(days / 31), 1 + (days % 31)];
  return [jy, 7 + Math.floor((days - 186) / 30), 1 + ((days - 186) % 30)];
}

/** Jalali (month 1-12) → Gregorian [year, month 1-12, day]. */
export function fromJalali(jy: number, jm: number, jd: number): [number, number, number] {
  const year = jy + 1595;
  let days =
    -355668 +
    365 * year +
    Math.floor(year / 33) * 8 +
    Math.floor(((year % 33) + 3) / 4) +
    jd +
    (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    days -= 1;
    gy += 100 * Math.floor(days / 36524);
    days %= 36524;
    if (days >= 365) days += 1;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  while (gm < 12 && gd > (lengths[gm] ?? 31)) {
    gd -= lengths[gm] ?? 31;
    gm += 1;
  }
  return [gy, gm + 1, gd];
}

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const PERSIAN_MONTHS = [
  "فروردین",
  "اردیبهشت",
  "خرداد",
  "تیر",
  "مرداد",
  "شهریور",
  "مهر",
  "آبان",
  "آذر",
  "دی",
  "بهمن",
  "اسفند",
];
/** Sunday-first, like `Date#getDay`. */
const PERSIAN_WEEKDAYS = ["ی", "د", "س", "چ", "پ", "ج", "ش"];

function persianDigits(value: number): string {
  return String(value).replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

function jalaliOf(date: Date): [number, number, number] {
  return toJalali(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function gregorianDate([y, m, d]: [number, number, number]): Date {
  return new Date(y, m - 1, d);
}

export const persian: CalendarSystem = {
  weekStartsOn: 6,
  startOfMonth: (date) => {
    const [jy, jm] = jalaliOf(date);
    return gregorianDate(fromJalali(jy, jm, 1));
  },
  addMonths: (monthStart, amount) => {
    const [jy, jm] = jalaliOf(monthStart);
    const index = jy * 12 + (jm - 1) + amount;
    return gregorianDate(fromJalali(Math.floor(index / 12), (index % 12) + 1, 1));
  },
  monthKey: (date) => {
    const [jy, jm] = jalaliOf(date);
    return jy * 12 + jm - 1;
  },
  year: (date) => jalaliOf(date)[0],
  monthIndex: (date) => jalaliOf(date)[1] - 1,
  fromYearMonth: (year, monthIndex) => gregorianDate(fromJalali(year, monthIndex + 1, 1)),
  formatCaption: (month) => {
    const [jy, jm] = jalaliOf(month);
    return `${PERSIAN_MONTHS[jm - 1]} ${persianDigits(jy)}`;
  },
  formatDay: (date) => persianDigits(jalaliOf(date)[2]),
  formatWeekday: (date) => PERSIAN_WEEKDAYS[date.getDay()] ?? "",
  formatMonth: (month) => PERSIAN_MONTHS[jalaliOf(month)[1] - 1] ?? "",
  formatYear: (year) => persianDigits(year),
  formatNumber: persianDigits,
};

function isRange(value: object): value is DateRange {
  return "from" in value;
}

/** Whether `date` matches any matcher (react-day-picker `dateMatchModifiers`). */
export function matches(date: Date, matchers: Matcher | Matcher[] | undefined): boolean {
  if (matchers === undefined) return false;
  const list: Matcher[] = Array.isArray(matchers) ? matchers : [matchers];
  return list.some((matcher) => {
    if (typeof matcher === "boolean") return matcher;
    if (typeof matcher === "function") return matcher(date);
    if (matcher instanceof Date) return isSameDay(date, matcher);
    if (Array.isArray(matcher)) return matcher.some((day) => isSameDay(date, day));
    if (isRange(matcher)) return inRange(date, matcher);
    if ("dayOfWeek" in matcher) {
      const days = Array.isArray(matcher.dayOfWeek) ? matcher.dayOfWeek : [matcher.dayOfWeek];
      return days.includes(date.getDay());
    }
    const before = "before" in matcher ? matcher.before : undefined;
    const after = "after" in matcher ? matcher.after : undefined;
    if (before && after) {
      return isAfter(before, after)
        ? isBefore(date, before) && isAfter(date, after)
        : isBefore(date, before) || isAfter(date, after);
    }
    if (before) return isBefore(startOfDay(date), startOfDay(before));
    if (after) return isAfter(startOfDay(date), startOfDay(after));
    return false;
  });
}

/** `from <= date <= to`, by calendar day. */
export function inRange(date: Date, range: DateRange): boolean {
  const { from, to } = range;
  if (!from) return false;
  if (!to) return isSameDay(date, from);
  const start = isAfter(from, to) ? to : from;
  const end = isAfter(from, to) ? from : to;
  return (
    !isBefore(startOfDay(date), startOfDay(start)) && !isAfter(startOfDay(date), startOfDay(end))
  );
}

/** react-day-picker v9 `addToRange`: the next range after clicking `date`. */
export function addToRange(
  date: Date,
  initial: DateRange | undefined,
  min = 0,
  max = 0,
  required = false,
): DateRange | undefined {
  const { from, to } = initial ?? { from: undefined, to: undefined };
  let range: DateRange | undefined;
  if (!from && !to) {
    range = { from: date, to: min > 0 ? undefined : date };
  } else if (from && !to) {
    if (isSameDay(from, date)) {
      if (min === 0) range = { from, to: date };
      else range = required ? { from, to: undefined } : undefined;
    } else if (isBefore(date, from)) {
      range = { from: date, to: from };
    } else {
      range = { from, to: date };
    }
  } else if (from && to) {
    if (isSameDay(from, date) && isSameDay(to, date)) {
      range = required ? { from, to } : undefined;
    } else if (isSameDay(from, date)) {
      range = { from, to: min > 0 ? undefined : date };
    } else if (isSameDay(to, date)) {
      range = { from: date, to: min > 0 ? undefined : date };
    } else if (isBefore(date, from)) {
      range = { from: date, to };
    } else {
      range = { from, to: date };
    }
  } else if (to) {
    range = { from: date, to };
  }
  if (range?.from && range.to) {
    const span = Math.round(
      (startOfDay(range.to).getTime() - startOfDay(range.from).getTime()) / 864e5,
    );
    if (max > 0 && span > max) range = { from: date, to: undefined };
    else if (min > 1 && span < min) range = { from: date, to: undefined };
  }
  return range;
}

/** The weeks (arrays of 7 days) covering `month`, padded to 6 weeks when `fixed`. */
export function monthWeeks(
  month: Date,
  system: CalendarSystem,
  weekStartsOn: number,
  fixed: boolean,
): Date[][] {
  const start = system.startOfMonth(month);
  const end = addDays(system.addMonths(start, 1), -1);
  const lead = (start.getDay() - weekStartsOn + 7) % 7;
  let cursor = addDays(start, -lead);
  const weeks: Date[][] = [];
  while (
    weeks.length < (fixed ? 6 : 7) &&
    (fixed || !isAfter(startOfDay(cursor), startOfDay(end)))
  ) {
    const week = Array.from({ length: 7 }, (_, i) => addDays(cursor, i));
    weeks.push(week);
    cursor = addDays(cursor, 7);
  }
  return weeks;
}
