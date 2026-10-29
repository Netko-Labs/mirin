import { format } from "date-fns";
import * as React from "react";
import { Button } from "../../src/components/button.tsx";
import { Calendar } from "../../src/components/calendar.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../../src/components/popover.tsx";
import { CalendarIcon } from "../../src/icons/index.ts";
import { cn } from "../../src/lib/cn.ts";

export default function DatePickerDemo() {
  const [date, setDate] = React.useState<Date>();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={"outline"}
          className={cn(
            "w-[240px] justify-start text-left font-normal",
            !date && "text-muted-foreground",
          )}
        >
          <CalendarIcon />
          {date ? format(date, "PPP") : <span>Pick a date</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar mode="single" selected={date} onSelect={setDate} initialFocus />
      </PopoverContent>
    </Popover>
  );
}
