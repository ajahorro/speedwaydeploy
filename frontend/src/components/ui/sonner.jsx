"use client"

import { Toaster as Sonner } from "sonner"
import {
  CheckCircle2,
  Info,
  Loader2,
  XOctagon,
  AlertTriangle,
} from "lucide-react"
import { useTheme } from "@/context/ThemeContext"

/**
 * The one toast host for the whole app (shadcn "Sonner"). Every `toast.*()` call goes through
 * `@/lib/toast`, which wraps Sonner, so a toast looks the same wherever it comes from.
 * Colours are the shadcn tokens, which are aliases of the shop's own --admin-* tokens, so the
 * toasts follow the light and dark theme without any extra work.
 */
function Toaster({ ...props }) {
  const { resolvedTheme } = useTheme() || {}

  return (
    <Sonner
      theme={resolvedTheme === "light" ? "light" : "dark"}
      className="toaster group"
      position="top-right"
      offset={{ top: 76, right: 20 }}
      mobileOffset={{ top: 76, right: 12, left: 12 }}
      visibleToasts={3}
      gap={12}
      duration={4000}
      expand
      icons={{
        success: <CheckCircle2 className="size-4" style={{ color: "var(--status-success)" }} />,
        info: <Info className="size-4" style={{ color: "var(--admin-info)" }} />,
        warning: <AlertTriangle className="size-4" style={{ color: "var(--status-warning)" }} />,
        error: <XOctagon className="size-4" style={{ color: "var(--status-danger)" }} />,
        loading: <Loader2 className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast: "group toast !gap-3 !border !shadow-lg",
          title: "!text-sm !font-semibold",
          description: "!text-xs !text-muted-foreground",
          actionButton: "!bg-primary !text-primary-foreground",
          cancelButton: "!bg-muted !text-muted-foreground",
        },
      }}
      style={{
        "--normal-bg": "var(--popover)",
        "--normal-text": "var(--popover-foreground)",
        "--normal-border": "var(--border)",
        "--border-radius": "var(--radius)",
        "--width": "356px",
        zIndex: "var(--z-toast, 9999)",
      }}
      {...props}
    />
  )
}

export { Toaster }
