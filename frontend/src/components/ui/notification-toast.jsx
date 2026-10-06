import { ArrowRight, Bell, X } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * The card for a notification that pops up on its own (a new booking, a message, ...).
 * Used with `toast.custom`, so the host only positions it and this component draws it:
 * an icon, what happened, a hint, one clear action, and a close button.
 */
function NotificationToast({ title, description, actionLabel = "View", onAction, onClose, icon: Icon = Bell, className }) {
  return (
    <div
      data-slot="notification-toast"
      role="status"
      className={cn(
        "flex w-[356px] max-w-[calc(100vw-1.5rem)] items-start gap-3 border bg-popover p-4 text-popover-foreground shadow-lg",
        className
      )}
      style={{ borderRadius: "var(--radius)", borderColor: "var(--border)" }}
    >
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="text-sm font-semibold leading-snug">{title}</p>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
        {onAction && (
          <button
            type="button"
            onClick={onAction}
            className="mt-1 inline-flex w-fit cursor-pointer items-center gap-1 text-xs font-semibold text-primary hover:underline"
          >
            {actionLabel} <ArrowRight className="size-3" aria-hidden="true" />
          </button>
        )}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss notification"
          className="-mr-1 -mt-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

export { NotificationToast }
