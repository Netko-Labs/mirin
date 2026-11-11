/**
 * lucide icons on Metal. `createLucideIcon(name, node)` mirrors lucide-react:
 * the icon takes `size`, `color`, `strokeWidth`, and `className` (`size-4`,
 * `text-muted-foreground`), defaults to the inherited text color like
 * `currentColor`, and to the inherited icon size (`[&_svg]:size-4`) or 16px.
 * `node` may be a function that loads the data: the generated icons read
 * their file of the `lucide` package when they first render, so importing
 * the icons costs no data.
 */

import { Svg, View } from "@mirinjs/metal";
import { type ReactNode, useMemo } from "react";
import { useInherited } from "../runtime/context.ts";
import { useHasRegistration } from "../runtime/has.ts";
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

/** An icon's vector data, or a function that loads the module whose default export it is. */
export type IconSource = IconNode | (() => { default: IconNode });

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

const NO_ATTRS = {};

export function createLucideIcon(name: string, source: IconSource): LucideIcon {
  // Made by the first render: 2,000 icons are created, a handful are drawn.
  let markups: Map<number, string> | undefined;
  function Icon({ size, color, strokeWidth = 2, className }: LucideProps): ReactNode {
    // Icons render as <svg> on the web, so `has-[>svg]` matches them.
    useHasRegistration("svg", NO_ATTRS, "");
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
    let markup = markups?.get(stroke);
    if (!markup) {
      markup = markupFor(typeof source === "function" ? source().default : source, stroke);
      markups ??= new Map();
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
