/**
 * The markup of the `react-day-picker` stand-in: each part is a default
 * component (`Root`, `Nav`, `MonthCaption`, `Day`, …) that `components`
 * overrides replace, rendered with the `classNames` entry of its `UI` name
 * and react-day-picker's `data-*` attributes.
 */

import { format } from "date-fns";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import type { SyntheticEvent } from "../../runtime/events.ts";
import {
  type CalendarDay,
  type CalendarMonth,
  Chevron,
  type ClassNames,
  type CustomComponents,
  DayButton,
  type DayPickerProps,
  type Formatters,
  getDefaultClassNames,
  type Modifiers,
} from "../react-day-picker.tsx";
import type { CalendarSystem } from "./day-picker-dates.ts";

type Html = Record<string, unknown> & { className?: string; children?: React.ReactNode };

function Root({ rootRef, ...props }: Html & { rootRef?: React.Ref<HTMLDivElement> }) {
  return <div ref={rootRef} {...props} />;
}

function Nav({
  onPreviousClick,
  onNextClick,
  previousMonth,
  nextMonth,
  classNames,
  components,
  ...props
}: Html & {
  onPreviousClick?: (event: SyntheticEvent) => void;
  onNextClick?: (event: SyntheticEvent) => void;
  previousMonth?: Date;
  nextMonth?: Date;
  classNames?: ClassNames;
  components?: CustomComponents;
}) {
  const names = classNames ?? getDefaultClassNames();
  const Previous = components?.PreviousMonthButton ?? Button;
  const Next = components?.NextMonthButton ?? Button;
  const Icon = components?.Chevron ?? Chevron;
  return (
    <nav {...props}>
      <Previous
        type="button"
        // metal: a test handle for the harness; react-day-picker has none.
        data-testid="rdp-button_previous"
        className={names.button_previous}
        aria-disabled={previousMonth ? undefined : true}
        aria-label="Go to the Previous Month"
        onClick={onPreviousClick}
      >
        <Icon disabled={!previousMonth} orientation="left" className={names.chevron} />
      </Previous>
      <Next
        type="button"
        data-testid="rdp-button_next"
        className={names.button_next}
        aria-disabled={nextMonth ? undefined : true}
        aria-label="Go to the Next Month"
        onClick={onNextClick}
      >
        <Icon disabled={!nextMonth} orientation="right" className={names.chevron} />
      </Next>
    </nav>
  );
}

function Button(props: Html) {
  return <button type="button" {...props} />;
}

function Dropdown({
  options,
  className,
  classNames,
  components,
  ...selectProps
}: Html & {
  options?: { value: number; label: string; disabled: boolean }[];
  value?: string;
  classNames: ClassNames;
  components: CustomComponents;
}) {
  const selected = options?.find((option) => String(option.value) === selectProps.value);
  const Icon = components.Chevron;
  return (
    <span data-disabled={selectProps.disabled} className={classNames.dropdown_root}>
      <select className={cn(classNames.dropdown, className)} {...selectProps}>
        {options?.map(({ value, label, disabled }) => (
          <option key={value} value={String(value)} disabled={disabled}>
            {label}
          </option>
        ))}
      </select>
      <span className={classNames.caption_label} aria-hidden>
        {selected?.label}
        <Icon orientation="down" size={18} className={classNames.chevron} />
      </span>
    </span>
  );
}

function tag(name: string) {
  return function Part({
    week: _w,
    day: _d,
    modifiers: _m,
    calendarMonth: _c,
    displayIndex: _i,
    ...props
  }: Html) {
    const Tag = name as "div";
    return <Tag {...props} />;
  };
}

/** Built lazily: this module and `react-day-picker.tsx` import each other. */
const defaults = (): CustomComponents => ({
  Root,
  Chevron,
  DayButton,
  Day: tag("td"),
  WeekNumber: tag("th"),
  WeekNumberHeader: tag("th"),
  Weekday: tag("th"),
  Weekdays: ({ children, ...props }: Html) => (
    <thead aria-hidden>
      <tr {...props}>{children}</tr>
    </thead>
  ),
  Week: tag("tr"),
  Weeks: tag("tbody"),
  MonthGrid: tag("table"),
  Months: tag("div"),
  Month: tag("div"),
  MonthCaption: tag("div"),
  CaptionLabel: tag("span"),
  Nav: Nav as CustomComponents["Nav"],
  PreviousMonthButton: Button,
  NextMonthButton: Button,
  DropdownNav: tag("div"),
  Dropdown: Dropdown as CustomComponents["Dropdown"],
  Footer: tag("div"),
});

const FLAGS = [
  "selected",
  "today",
  "outside",
  "disabled",
  "hidden",
  "focused",
  "range_start",
  "range_middle",
  "range_end",
] as const;

export interface PartsInput {
  props: DayPickerProps;
  system: CalendarSystem;
  months: CalendarMonth[];
  month: Date;
  startMonth: Date | undefined;
  endMonth: Date | undefined;
  previousMonth: Date | undefined;
  nextMonth: Date | undefined;
  formatters: Formatters;
  modifiersOf: (day: CalendarDay) => Modifiers;
  onSelect: (day: CalendarDay, modifiers: Modifiers, event: SyntheticEvent) => void;
  goTo: (month: Date) => void;
}

function captionDropdowns(
  input: PartsInput,
  calendarMonth: CalendarMonth,
  c: CustomComponents,
  names: ClassNames,
) {
  const { props, system, formatters, startMonth, endMonth } = input;
  const date = calendarMonth.date;
  const year = system.year(date);
  const firstKey = startMonth ? system.monthKey(startMonth) : Number.NEGATIVE_INFINITY;
  const lastKey = endMonth ? system.monthKey(endMonth) : Number.POSITIVE_INFINITY;
  const monthOptions = Array.from({ length: 12 }, (_, index) => {
    const candidate = system.fromYearMonth(year, index);
    const key = system.monthKey(candidate);
    return {
      value: index,
      label: formatters.formatMonthDropdown(candidate, { locale: props.locale as never }),
      disabled: key < firstKey || key > lastKey,
    };
  });
  const fromYear = startMonth ? system.year(startMonth) : year - 100;
  const toYear = endMonth ? system.year(endMonth) : year;
  const yearOptions = Array.from({ length: Math.max(1, toYear - fromYear + 1) }, (_, index) => {
    const value = fromYear + index;
    return {
      value,
      label: formatters.formatYearDropdown(system.fromYearMonth(value, 0)),
      disabled: false,
    };
  });
  const layout = props.captionLayout ?? "label";
  const showMonths = layout === "dropdown" || layout === "dropdown-months";
  const showYears = layout === "dropdown" || layout === "dropdown-years";
  return (
    <c.DropdownNav className={names.dropdowns}>
      {showMonths ? (
        <c.Dropdown
          className={names.months_dropdown}
          aria-label="Choose the Month"
          classNames={names}
          components={c}
          options={monthOptions}
          value={String(system.monthIndex(date))}
          onChange={(event: SyntheticEvent) =>
            input.goTo(system.fromYearMonth(year, Number(event.target.value)))
          }
        />
      ) : (
        <span>{system.formatMonth(date)}</span>
      )}
      {showYears ? (
        <c.Dropdown
          className={names.years_dropdown}
          aria-label="Choose the Year"
          classNames={names}
          components={c}
          options={yearOptions}
          value={String(year)}
          onChange={(event: SyntheticEvent) =>
            input.goTo(system.fromYearMonth(Number(event.target.value), system.monthIndex(date)))
          }
        />
      ) : (
        <span>{system.formatYear(year)}</span>
      )}
    </c.DropdownNav>
  );
}

export function DayPickerParts(input: PartsInput) {
  const { props, months, formatters, modifiersOf } = input;
  const names: ClassNames = { ...getDefaultClassNames(), ...props.classNames };
  const c: CustomComponents = { ...defaults(), ...props.components };
  const interactive = props.mode !== undefined || props.onDayClick !== undefined;
  const layout = props.captionLayout ?? "label";
  const weekdays = months[0]?.weeks[0]?.days.map((day) => day.date) ?? [];
  const nav = props.hideNavigation ? null : (
    <c.Nav
      className={names.nav}
      classNames={names}
      components={c}
      previousMonth={input.previousMonth}
      nextMonth={input.nextMonth}
      onPreviousClick={() => input.previousMonth && input.goTo(input.previousMonth)}
      onNextClick={() => input.nextMonth && input.goTo(input.nextMonth)}
    />
  );
  const extra = Object.fromEntries(
    Object.entries(props).filter(([key]) => key.startsWith("data-") || key.startsWith("aria-")),
  );
  return (
    <c.Root
      className={cn(names.root, props.className)}
      style={props.style}
      dir={props.dir}
      id={props.id}
      lang={props.lang}
      data-mode={props.mode}
      data-required={props.required || undefined}
      data-multiple-months={months.length > 1 || undefined}
      data-week-numbers={props.showWeekNumber || undefined}
      data-nav-layout={props.navLayout}
      {...extra}
    >
      <c.Months className={names.months}>
        {props.navLayout === "around" ? null : nav}
        {months.map((calendarMonth, displayIndex) => (
          <c.Month
            key={calendarMonth.date.getTime()}
            className={names.month}
            calendarMonth={calendarMonth}
            displayIndex={displayIndex}
          >
            <c.MonthCaption
              className={names.month_caption}
              calendarMonth={calendarMonth}
              displayIndex={displayIndex}
            >
              {layout.startsWith("dropdown") ? (
                captionDropdowns(input, calendarMonth, c, names)
              ) : (
                <c.CaptionLabel className={names.caption_label} role="status" aria-live="polite">
                  {formatters.formatCaption(calendarMonth.date, { locale: props.locale as never })}
                </c.CaptionLabel>
              )}
            </c.MonthCaption>
            <c.MonthGrid role="grid" className={names.month_grid}>
              {props.hideWeekdays ? null : (
                <c.Weekdays className={names.weekdays}>
                  {props.showWeekNumber ? (
                    <c.WeekNumberHeader
                      className={names.week_number_header}
                      aria-label="Week Number"
                    />
                  ) : null}
                  {weekdays.map((weekday) => (
                    <c.Weekday key={weekday.getTime()} className={names.weekday} scope="col">
                      {formatters.formatWeekdayName(weekday, { locale: props.locale as never })}
                    </c.Weekday>
                  ))}
                </c.Weekdays>
              )}
              <c.Weeks className={names.weeks}>
                {calendarMonth.weeks.map((week) => (
                  <c.Week key={week.days[0]?.date.getTime()} className={names.week} week={week}>
                    {props.showWeekNumber ? (
                      <c.WeekNumber week={week} className={names.week_number} role="rowheader">
                        {formatters.formatWeekNumber(week.weekNumber)}
                      </c.WeekNumber>
                    ) : null}
                    {week.days.map((day) => {
                      const modifiers = modifiersOf(day);
                      const flagClasses = FLAGS.filter((flag) => modifiers[flag]).map(
                        (flag) => names[flag],
                      );
                      const customClasses = Object.entries(props.modifiersClassNames ?? {})
                        .filter(([name]) => modifiers[name])
                        .map(([, value]) => value);
                      return (
                        <c.Day
                          key={day.date.getTime()}
                          day={day}
                          modifiers={modifiers}
                          className={cn(names.day, flagClasses, customClasses)}
                          role="gridcell"
                          aria-selected={modifiers.selected || undefined}
                          data-day={format(day.date, "yyyy-MM-dd")}
                          data-month={day.outside ? format(day.displayMonth, "yyyy-MM") : undefined}
                          data-selected={modifiers.selected || undefined}
                          data-disabled={modifiers.disabled || undefined}
                          data-hidden={modifiers.hidden || undefined}
                          data-outside={day.outside || undefined}
                          data-focused={modifiers.focused || undefined}
                          data-today={modifiers.today || undefined}
                        >
                          {modifiers.hidden ? null : interactive ? (
                            <c.DayButton
                              className={names.day_button}
                              type="button"
                              day={day}
                              modifiers={modifiers}
                              disabled={modifiers.disabled || undefined}
                              aria-label={day.date.toDateString()}
                              onClick={(event: SyntheticEvent) =>
                                input.onSelect(day, modifiers, event)
                              }
                            >
                              {formatters.formatDay(day.date, { locale: props.locale as never })}
                            </c.DayButton>
                          ) : (
                            formatters.formatDay(day.date, { locale: props.locale as never })
                          )}
                        </c.Day>
                      );
                    })}
                  </c.Week>
                ))}
              </c.Weeks>
            </c.MonthGrid>
          </c.Month>
        ))}
        {props.navLayout === "around" ? nav : null}
      </c.Months>
      {props.footer ? (
        <c.Footer className={names.footer} role="status" aria-live="polite">
          {props.footer}
        </c.Footer>
      ) : null}
    </c.Root>
  );
}
