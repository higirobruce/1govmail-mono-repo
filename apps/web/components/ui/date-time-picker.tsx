"use client"

import * as React from "react"
import { format, parseISO, isValid } from "date-fns"
import { CalendarIcon, Clock } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

interface DateTimePickerProps {
  /** ISO string value (datetime or date-only) */
  value: string
  onChange: (isoValue: string) => void
  /** When true, only a date is shown (no time selector) */
  dateOnly?: boolean
  className?: string
  disabled?: boolean
}

export function DateTimePicker({
  value,
  onChange,
  dateOnly = false,
  className,
  disabled,
}: DateTimePickerProps) {
  const [open, setOpen] = React.useState(false)

  // Parse the incoming value into a Date (or undefined)
  const parsed = React.useMemo(() => {
    if (!value) return undefined
    const d = dateOnly
      ? new Date(value + "T00:00:00")   // avoid UTC shift for date-only
      : parseISO(value)
    return isValid(d) ? d : undefined
  }, [value, dateOnly])

  // hours / minutes for the time input
  const timeStr = React.useMemo(() => {
    if (!parsed) return "00:00"
    return format(parsed, "HH:mm")
  }, [parsed])

  // User picks a day in the calendar
  const handleDaySelect = (day: Date | undefined) => {
    if (!day) return
    if (dateOnly) {
      onChange(format(day, "yyyy-MM-dd"))
    } else {
      const [h, m] = timeStr.split(":").map(Number)
      day.setHours(h, m, 0, 0)
      // Use local-time format so the stored value matches what the user sees
      onChange(format(day, "yyyy-MM-dd'T'HH:mm"))
    }
    if (dateOnly) setOpen(false)
  }

  // User changes the time input
  const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const [h, m] = e.target.value.split(":").map(Number)
    const base = parsed ? new Date(parsed) : new Date()
    base.setHours(h, m, 0, 0)
    // Use local-time format — toISOString() would shift to UTC and cause an offset bug
    onChange(format(base, "yyyy-MM-dd'T'HH:mm"))
  }

  const displayLabel = parsed
    ? dateOnly
      ? format(parsed, "MMM d, yyyy")
      : format(parsed, "MMM d, yyyy  HH:mm")
    : dateOnly
    ? "Pick a date"
    : "Pick date & time"

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className={cn(
            "h-8 w-full justify-start text-left text-xs font-normal bg-muted/30 border-border/50",
            !parsed && "text-muted-foreground",
            className
          )}
        >
          <CalendarIcon className="mr-2 size-3.5 shrink-0 text-muted-foreground" />
          {displayLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={parsed}
          onSelect={handleDaySelect}
          initialFocus
        />
        {!dateOnly && (
          <div className="border-t border-border px-3 py-2 flex items-center gap-2">
            <Clock className="size-3.5 text-muted-foreground shrink-0" />
            <Input
              type="time"
              value={timeStr}
              onChange={handleTimeChange}
              onBlur={() => setOpen(false)}
              className="h-8 text-sm border-0 bg-transparent px-0 focus-visible:ring-0 shadow-none"
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
