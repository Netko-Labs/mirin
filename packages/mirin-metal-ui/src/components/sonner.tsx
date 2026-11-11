import type * as React from "react";
import { useTheme } from "../compat/next-themes.ts";
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "../icons/core.generated.ts";
import { registerOverlayChild } from "../overlay/host.tsx";
import { Toaster as Sonner, type ToasterProps } from "../primitives/sonner.tsx";

// metal: upstream ui/sonner.tsx verbatim except imports. The port script maps
// every `sonner` import here, so this module also re-exports sonner's `toast`
// API (from the `primitives/sonner.tsx` stand-in) and registers a fallback
// <Toaster /> with the overlay host, so `toast()` shows without mounting one
// (shadcn mounts it in the app layout; examples only render the triggers).

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

function AmbientToaster() {
  return <Toaster ambient />;
}

registerOverlayChild(AmbientToaster);

export { Toaster };
export { type ExternalToast, type ToastT, toast, useSonner } from "../primitives/sonner.tsx";
