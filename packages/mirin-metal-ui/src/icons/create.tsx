/**
 * lucide icons on Metal. `createLucideIcon(name, node)` mirrors lucide-react:
 * the icon takes `size`, `color`, `strokeWidth`, and `className` (`size-4`,
 * `text-muted-foreground`), defaults to the inherited text color like
 * `currentColor`, and to the inherited icon size (`[&_svg]:size-4`) or 16px.
 */

import { Svg, View } from "@mirinjs/metal";
import { type ReactNode, useMemo } from "react";
import { useInherited } from "../runtime/context.ts";
import { useTheme } from "../theme.ts";
import { translate } from "../tw/index.ts";

export type IconNode = ReadonlyArray<
  readonly [string, Readonly<Record<string, string | number | undefined>>]
>;

export interface LucideProps {
  size?: number | string;
  color?: string;
  strokeWidth?: number | string;
  absoluteStrokeWidth?: boolean;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
  [attr: string]: unknown;
}

export type LucideIcon = ((props: LucideProps) => ReactNode) & {
  displayName: string;
  inline: true;
};

function markupFor(node: IconNode, strokeWidth: number): string {
  const body = node
    .map(([tag, attrs]) => {
      const rendered = Object.entries(attrs)
        .filter(([key]) => key !== "key")
        .map(
          ([key, value]) => `${key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}="${value}"`,
        )
        .join(" ");
      return `<${tag} ${rendered}/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

export function createLucideIcon(name: string, node: IconNode): LucideIcon {
  const markups = new Map<number, string>();
  function Icon({ size, color, strokeWidth = 2, className }: LucideProps): ReactNode {
    const theme = useTheme();
    const inherited = useInherited();
    const tw = useMemo(
      () =>
        translate(className, theme.colors, theme.radius, {
          attrs: {},
          groups: {},
          dark: theme.mode === "dark",
          viewportWidth: theme.viewportWidth,
        }),
      [className, theme],
    );
    if (tw.hidden) return null;
    const stroke = Number(strokeWidth) || 2;
    let markup = markups.get(stroke);
    if (!markup) {
      markup = markupFor(node, stroke);
      markups.set(stroke, markup);
    }
    const numeric = Number(size);
    const width =
      (typeof tw.view.width === "number" ? tw.view.width : undefined) ??
      (Number.isFinite(numeric) && numeric > 0 ? numeric : undefined) ??
      inherited.svg.size ??
      16;
    const height = typeof tw.view.height === "number" ? tw.view.height : width;
    const tint =
      tw.text.color ??
      (color && color !== "currentColor" ? color : undefined) ??
      inherited.svg.color ??
      inherited.text.color ??
      theme.colors.foreground;
    const svg = (
      <Svg markup={markup} width={width} height={height} color={tint} opacity={tw.view.opacity} />
    );
    // `absolute right-3 …` icons (select chevrons, input adornments) float
    // over their relative parent instead of taking a slot in the row.
    if (tw.view.position !== "absolute") return svg;
    const { top, left, right, bottom } = tw.view;
    return <View style={{ position: "absolute", top, left, right, bottom }}>{svg}</View>;
  }
  const component = Icon as LucideIcon;
  component.displayName = name;
  component.inline = true;
  return component;
}
