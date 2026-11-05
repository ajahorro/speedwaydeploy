import * as React from "react"
import { cn } from "@/lib/utils"
import { Switch as SwitchPrimitive } from "radix-ui"

/**
 * On/off switch used everywhere in the app (settings, accounts, staff editing...).
 *
 * Sized for fingers as well as mice:
 *  - mouse/trackpad: 36×20 track, 16px knob;
 *  - touch screens (pointer: coarse): 48×28 track, 24px knob;
 *  - an invisible 8px margin (::before) widens the tap area to ~44px tall on touch screens, the usual minimum.
 * It never shrinks inside a crowded row (shrink-0) and follows the light/dark theme tokens.
 */
function Switch({
  className,
  size = "default",
  ...props
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent p-px shadow-xs transition-all outline-none",
        "before:absolute before:-inset-2 before:content-['']",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        "data-[size=default]:h-5 data-[size=default]:w-9 pointer-coarse:data-[size=default]:h-7 pointer-coarse:data-[size=default]:w-12",
        "data-[size=sm]:h-4 data-[size=sm]:w-7 pointer-coarse:data-[size=sm]:h-6 pointer-coarse:data-[size=sm]:w-10",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-background shadow-sm ring-0 transition-transform data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground",
          "group-data-[size=default]/switch:size-4 group-data-[size=default]/switch:data-[state=checked]:translate-x-4",
          "pointer-coarse:group-data-[size=default]/switch:size-6 pointer-coarse:group-data-[size=default]/switch:data-[state=checked]:translate-x-5",
          "group-data-[size=sm]/switch:size-3 group-data-[size=sm]/switch:data-[state=checked]:translate-x-3",
          "pointer-coarse:group-data-[size=sm]/switch:size-5 pointer-coarse:group-data-[size=sm]/switch:data-[state=checked]:translate-x-4"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
