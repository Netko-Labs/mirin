/**
 * `react-day-picker` (v9) on Metal: `DayPicker` with `single`, `multiple`,
 * and `range` modes, controlled/uncontrolled month, `numberOfMonths`,
 * `captionLayout` label/dropdown, outside days, week numbers, `disabled`
 * matchers, and the `classNames`/`components` overrides shadcn's
 * `ui/calendar.tsx` passes. Parts render react-day-picker's own markup
 * (`root`, `months`, `nav`, `month_caption`, `month_grid`, `weekdays`,
 * `week`, `day`, `day_button`, …) with the classNames keyed by its `UI`
 * names, so the upstream styling applies. Dates come from date-fns.
 */

import type { Locale } from "date-fns";
import { format } from "date-fns/format";
import { isAfter } from "date-fns/isAfter";
import { isBefore } from "date-fns/isBefore";
import { isSameDay } from "date-fns/isSameDay";
import { startOfDay } from "date-fns/startOfDay";
import type * as React from "react";
import { useState } from "react";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "../icons/core.generated.ts";
import { cn } from "../lib/cn.ts";
import { useControllableState } from "../lib/state.ts";
import type { SyntheticEvent } from "../runtime/events.ts";
import {
  addToRange,
  type CalendarSystem,
  type DateRange,
  gregorian,
  inRange,
  type Matcher,
  matches,
  monthWeeks,
} from "./lib/day-picker-dates.ts";
import { DayPickerParts } from "./lib/day-picker-parts.tsx";

export type {
  DateAfter,
  DateBefore,
  DateInterval,
  DateRange,
  DayOfWeek,
  Matcher,
} from "./lib/day-picker-dates.ts";
export type { Locale };

/** react-day-picker's `UI` element names (the keys of `classNames`). */
export const UI = {
  Root: "root",
  Chevron: "chevron",
  Day: "day",
  DayButton: "day_button",
  CaptionLabel: "caption_label",
  Dropdowns: "dropdowns",
  Dropdown: "dropdown",
  DropdownRoot: "dropdown_root",
  Footer: "footer",
  MonthGrid: "month_grid",
  MonthCaption: "month_caption",
  MonthsDropdown: "months_dropdown",
  Month: "month",
  Months: "months",
  Nav: "nav",
  NextMonthButton: "button_next",
  PreviousMonthButton: "button_previous",
  Week: "week",
  Weeks: "weeks",
  Weekday: "weekday",
  Weekdays: "weekdays",
  WeekNumber: "week_number",
  WeekNumberHeader: "week_number_header",
  YearsDropdown: "years_dropdown",
} as const;

export const DayFlag = {
  disabled: "disabled",
  hidden: "hidden",
  outside: "outside",
  focused: "focused",
  today: "today",
} as const;

export const SelectionState = {
  range_end: "range_end",
  range_middle: "range_middle",
  range_start: "range_start",
  selected: "selected",
} as const;

type UIName = (typeof UI)[keyof typeof UI];
type FlagName = keyof typeof DayFlag | keyof typeof SelectionState;
export type ClassNames = Record<UIName | FlagName, string>;

/** `rdp-root`, `rdp-day_button`, … — the class names react-day-picker ships. */
export function getDefaultClassNames(): ClassNames {
  const names = [...Object.values(UI), ...Object.keys(DayFlag), ...Object.keys(SelectionState)];
  return Object.fromEntries(names.map((name) => [name, `rdp-${name}`])) as ClassNames;
}

export type Modifiers = Record<string, boolean>;

/** One day cell of a displayed month. */
export class CalendarDay {
  readonly date: Date;
  readonly displayMonth: Date;
  readonly outside: boolean;
  constructor(date: Date, displayMonth: Date, outside: boolean) {
    this.date = date;
    this.displayMonth = displayMonth;
    this.outside = outside;
  }
  isEqualTo(day: CalendarDay): boolean {
    return isSameDay(day.date, this.date) && isSameDay(day.displayMonth, this.displayMonth);
  }
}

export interface CalendarWeek {
  weekNumber: number;
  days: CalendarDay[];
}

export interface CalendarMonth {
  date: Date;
  weeks: CalendarWeek[];
}

type Html = Record<string, unknown> & { className?: string; children?: React.ReactNode };

export interface ChevronProps {
  className?: string;
  size?: number;
  disabled?: boolean;
  orientation?: "up" | "down" | "left" | "right";
}

export interface DropdownOption {
  value: number;
  label: string;
  disabled: boolean;
}

export interface CustomComponents {
  Root: React.ComponentType<Html & { rootRef?: React.Ref<HTMLDivElement> }>;
  Chevron: React.ComponentType<ChevronProps>;
  DayButton: React.ComponentType<Html & { day: CalendarDay; modifiers: Modifiers }>;
  Day: React.ComponentType<Html & { day: CalendarDay; modifiers: Modifiers }>;
  WeekNumber: React.ComponentType<Html & { week: CalendarWeek }>;
  WeekNumberHeader: React.ComponentType<Html>;
  Weekday: React.ComponentType<Html>;
  Weekdays: React.ComponentType<Html>;
  Week: React.ComponentType<Html & { week: CalendarWeek }>;
  Weeks: React.ComponentType<Html>;
  MonthGrid: React.ComponentType<Html>;
  Months: React.ComponentType<Html>;
  Month: React.ComponentType<Html & { calendarMonth: CalendarMonth; displayIndex: number }>;
  MonthCaption: React.ComponentType<Html & { calendarMonth: CalendarMonth; displayIndex: number }>;
  CaptionLabel: React.ComponentType<Html>;
  Nav: React.ComponentType<
    Html & {
      onPreviousClick?: (event: SyntheticEvent) => void;
      onNextClick?: (event: SyntheticEvent) => void;
      previousMonth?: Date;
      nextMonth?: Date;
    }
  >;
  PreviousMonthButton: React.ComponentType<Html>;
  NextMonthButton: React.ComponentType<Html>;
  DropdownNav: React.ComponentType<Html>;
  Dropdown: React.ComponentType<
    Html & {
      options?: DropdownOption[];
      value?: string;
      onChange?: (event: SyntheticEvent) => void;
      classNames: ClassNames;
      components: CustomComponents;
    }
  >;
  Footer: React.ComponentType<Html>;
}

export interface Formatters {
  formatCaption: (month: Date, options?: { locale?: Locale }) => string;
  formatDay: (date: Date, options?: { locale?: Locale }) => string;
  formatMonthDropdown: (month: Date, options?: { locale?: Locale }) => string;
  formatYearDropdown: (year: Date, options?: { locale?: Locale }) => string;
  formatWeekdayName: (weekday: Date, options?: { locale?: Locale }) => string;
  formatWeekNumber: (weekNumber: number) => string;
}

export interface PropsBase {
  className?: string;
  style?: Record<string, unknown>;
  classNames?: Partial<ClassNames>;
  modifiersClassNames?: Record<string, string>;
  components?: Partial<CustomComponents>;
  formatters?: Partial<Formatters>;
  modifiers?: Record<string, Matcher | Matcher[] | undefined>;
  numberOfMonths?: number;
  month?: Date;
  defaultMonth?: Date;
  onMonthChange?: (month: Date) => void;
  startMonth?: Date;
  endMonth?: Date;
  /** @deprecated v8 names, still honored. */
  fromMonth?: Date;
  toMonth?: Date;
  fromYear?: number;
  toYear?: number;
  captionLayout?: "label" | "dropdown" | "dropdown-months" | "dropdown-years";
  navLayout?: "around" | "after";
  showOutsideDays?: boolean;
  fixedWeeks?: boolean;
  showWeekNumber?: boolean;
  hideWeekdays?: boolean;
  hideNavigation?: boolean;
  disableNavigation?: boolean;
  pagedNavigation?: boolean;
  reverseMonths?: boolean;
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  disabled?: Matcher | Matcher[];
  hidden?: Matcher | Matcher[];
  today?: Date;
  locale?: Partial<Locale>;
  footer?: React.ReactNode;
  dir?: string;
  lang?: string;
  id?: string;
  autoFocus?: boolean;
  /** @deprecated use `autoFocus`. */
  initialFocus?: boolean;
  required?: boolean;
  min?: number;
  max?: number;
  excludeDisabled?: boolean;
  timeZone?: string;
  onDayClick?: (date: Date, modifiers: Modifiers, event: SyntheticEvent) => void;
  [attr: `data-${string}` | `aria-${string}`]: unknown;
}

type Select<T> = (
  selected: T,
  triggerDate: Date,
  modifiers: Modifiers,
  event: SyntheticEvent,
) => void;

export interface PropsSingle {
  mode: "single";
  selected?: Date | undefined;
  onSelect?: Select<Date | undefined>;
}
export interface PropsMulti {
  mode: "multiple";
  selected?: Date[] | undefined;
  onSelect?: Select<Date[] | undefined>;
}
export interface PropsRange {
  mode: "range";
  selected?: DateRange | undefined;
  onSelect?: Select<DateRange | undefined>;
}
export interface PropsNone {
  mode?: undefined;
  selected?: undefined;
  onSelect?: undefined;
}

export type DayPickerProps = PropsBase & (PropsSingle | PropsMulti | PropsRange | PropsNone);

type Selected = Date | Date[] | DateRange | undefined;

/** The default `DayButton`: a plain button (exported for `ComponentProps<typeof DayButton>`). */
export function DayButton({
  day: _day,
  modifiers: _modifiers,
  ...props
}: Html & { day: CalendarDay; modifiers: Modifiers }) {
  return <button type="button" {...props} />;
}

export function Chevron({ className, orientation }: ChevronProps) {
  if (orientation === "left") return <ChevronLeftIcon className={cn("size-4", className)} />;
  if (orientation === "right") return <ChevronRightIcon className={cn("size-4", className)} />;
  return <ChevronDownIcon className={cn("size-4", className)} />;
}

function selectionModifiers(
  mode: DayPickerProps["mode"],
  selected: Selected,
  date: Date,
): Modifiers {
  if (!selected) return {};
  if (mode === "single") return { selected: selected instanceof Date && isSameDay(selected, date) };
  if (mode === "multiple") {
    return { selected: Array.isArray(selected) && selected.some((d) => isSameDay(d, date)) };
  }
  if (mode === "range" && !(selected instanceof Date) && !Array.isArray(selected)) {
    const { from, to } = selected;
    const on = inRange(date, selected);
    const start = !!from && isSameDay(from, date);
    const end = !!to && isSameDay(to, date);
    return {
      selected: on,
      range_start: start,
      range_end: end,
      range_middle: on && !start && !end,
    };
  }
  return {};
}

/** The calendar. `system` swaps in the Persian calendar (`react-day-picker/persian`). */
export function DayPickerWith(props: DayPickerProps, system: CalendarSystem) {
  const today = startOfDay(props.today ?? new Date());
  const weekStartsOn =
    props.weekStartsOn ??
    (props.locale?.options?.weekStartsOn as 0 | undefined) ??
    system.weekStartsOn;
  const locale = props.locale as Locale | undefined;
  const startMonth =
    props.startMonth ??
    props.fromMonth ??
    (props.fromYear !== undefined ? new Date(props.fromYear, 0, 1) : undefined) ??
    (props.captionLayout?.startsWith("dropdown")
      ? system.fromYearMonth(system.year(today) - 100, 0)
      : undefined);
  const endMonth =
    props.endMonth ??
    props.toMonth ??
    (props.toYear !== undefined ? new Date(props.toYear, 11, 1) : undefined) ??
    (props.captionLayout?.startsWith("dropdown")
      ? system.fromYearMonth(system.year(today), 11)
      : undefined);

  const [month, setMonthState] = useControllableState<Date>({
    prop: props.month ? system.startOfMonth(props.month) : undefined,
    defaultProp: system.startOfMonth(props.defaultMonth ?? today),
    onChange: props.onMonthChange,
  });
  // Controlled whenever `selected` is passed, even as `undefined` (react-day-picker semantics).
  const [ownSelected, setOwnSelected] = useState<Selected>(undefined);
  const controlled = "selected" in props;
  const selected: Selected = controlled ? props.selected : ownSelected;
  const setSelected = (next: Selected) => {
    if (!controlled) setOwnSelected(next);
  };

  const count = Math.max(1, props.numberOfMonths ?? 1);
  const step = props.pagedNavigation ? count : 1;
  const firstKey = startMonth ? system.monthKey(startMonth) : Number.NEGATIVE_INFINITY;
  const lastKey = endMonth ? system.monthKey(endMonth) : Number.POSITIVE_INFINITY;
  const clamp = (next: Date): Date => {
    const key = system.monthKey(next);
    if (key < firstKey && startMonth) return system.startOfMonth(startMonth);
    if (key + count - 1 > lastKey && endMonth)
      return system.addMonths(system.startOfMonth(endMonth), 1 - count);
    return next;
  };
  const goTo = (next: Date) => {
    if (props.disableNavigation) return;
    setMonthState(clamp(system.startOfMonth(next)));
  };
  const previousMonth =
    props.disableNavigation || system.monthKey(month) <= firstKey
      ? undefined
      : system.addMonths(month, -step);
  const nextMonth =
    props.disableNavigation || system.monthKey(month) + count - 1 >= lastKey
      ? undefined
      : system.addMonths(month, step);

  const formatters: Formatters = {
    formatCaption: (m) => system.formatCaption(m, locale),
    formatDay: (d) => system.formatDay(d, locale),
    formatMonthDropdown: (m) => system.formatMonth(m, locale),
    formatYearDropdown: (y) => system.formatYear(system.year(y)),
    formatWeekdayName: (d) => system.formatWeekday(d, locale),
    formatWeekNumber: (n) => system.formatNumber(n).padStart(2, system === gregorian ? "0" : "۰"),
    ...props.formatters,
  };

  const months: CalendarMonth[] = Array.from({ length: count }, (_, index) => {
    const date = system.addMonths(month, index);
    const weeks = monthWeeks(date, system, weekStartsOn, props.fixedWeeks === true).map((days) => ({
      weekNumber: Number(format(days[0] ?? date, "w", { weekStartsOn, locale })),
      days: days.map(
        (day) => new CalendarDay(day, date, system.monthKey(day) !== system.monthKey(date)),
      ),
    }));
    return { date, weeks };
  });
  if (props.reverseMonths) months.reverse();

  const modifiersOf = (day: CalendarDay): Modifiers => {
    const outside = day.outside;
    const disabled =
      matches(day.date, props.disabled) ||
      (startMonth !== undefined && isBefore(day.date, system.startOfMonth(startMonth))) ||
      (endMonth !== undefined &&
        isAfter(day.date, system.addMonths(system.startOfMonth(endMonth), 1)));
    const hidden = matches(day.date, props.hidden) || (outside && !props.showOutsideDays);
    const custom = Object.fromEntries(
      Object.entries(props.modifiers ?? {}).map(([name, matcher]) => [
        name,
        matches(day.date, matcher),
      ]),
    );
    return {
      ...custom,
      ...selectionModifiers(props.mode, selected, day.date),
      today: isSameDay(day.date, today),
      outside,
      disabled,
      hidden,
      focused: false,
    };
  };

  const select = (day: CalendarDay, modifiers: Modifiers, event: SyntheticEvent) => {
    props.onDayClick?.(day.date, modifiers, event);
    if (modifiers.disabled) return;
    const date = day.date;
    if (props.mode === "single") {
      const next = modifiers.selected && !props.required ? undefined : date;
      setSelected(next);
      props.onSelect?.(next, date, modifiers, event);
    } else if (props.mode === "multiple") {
      const current = Array.isArray(selected) ? selected : [];
      let next: Date[] | undefined;
      if (modifiers.selected) {
        if (props.required && current.length <= (props.min ?? 1)) return;
        next = current.filter((d) => !isSameDay(d, date));
      } else {
        if (props.max !== undefined && current.length >= props.max) return;
        next = [...current, date];
      }
      if (next.length === 0 && !props.required) next = undefined;
      setSelected(next);
      props.onSelect?.(next, date, modifiers, event);
    } else if (props.mode === "range") {
      const current =
        selected && !(selected instanceof Date) && !Array.isArray(selected) ? selected : undefined;
      const next = addToRange(date, current, props.min, props.max, props.required);
      setSelected(next);
      props.onSelect?.(next, date, modifiers, event);
    }
  };

  return (
    <DayPickerParts
      props={props}
      system={system}
      months={months}
      month={month}
      startMonth={startMonth}
      endMonth={endMonth}
      previousMonth={previousMonth}
      nextMonth={nextMonth}
      formatters={formatters}
      modifiersOf={modifiersOf}
      onSelect={select}
      goTo={goTo}
    />
  );
}

export function DayPicker(props: DayPickerProps) {
  return DayPickerWith(props, gregorian);
}
