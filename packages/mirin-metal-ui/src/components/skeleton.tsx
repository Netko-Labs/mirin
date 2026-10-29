import { cn } from "../lib/cn.ts";
import { Box } from "../lib/styled.tsx";

export function Skeleton({ className }: { className?: string }) {
  return <Box className={cn("h-4 rounded-md bg-accent", className)} />;
}
