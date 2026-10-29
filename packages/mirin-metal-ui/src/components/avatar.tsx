import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Box, Content } from "../lib/styled.tsx";

export function Avatar({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <Box
      className={cn(
        "flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted",
        className,
      )}
    >
      {children}
    </Box>
  );
}

/** Images are not rendered yet; the fallback always shows. */
export function AvatarImage(_props: { src?: string; alt?: string; className?: string }) {
  return null;
}

export function AvatarFallback({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Box className={cn("flex items-center justify-center text-sm font-medium", className)}>
      <Content>{children}</Content>
    </Box>
  );
}
