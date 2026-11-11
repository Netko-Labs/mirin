/**
 * `react-day-picker/persian` on Metal: the same `DayPicker` over the
 * Persian (Jalali, Solar Hijri) calendar: months, captions, weekday names,
 * and numerals are Persian, weeks start on Saturday.
 * metal: the layout stays left-to-right (no `dir="rtl"` mirroring yet).
 */

import { persian } from "./lib/day-picker-dates.ts";
import { type DayPickerProps, DayPickerWith } from "./react-day-picker.tsx";

export * from "./react-day-picker.tsx";

export function DayPicker(props: DayPickerProps) {
  return DayPickerWith({ dir: "rtl", ...props }, persian);
}
