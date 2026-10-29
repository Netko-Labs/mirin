/**
 * `<img>` and inline `<svg>`. Remote images are downloaded once into a local
 * cache (the renderer reads files); inline SVG element trees are serialized
 * back to markup and drawn as icons tinted with the current text color.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Image, Svg } from "@mirinjs/metal";
import { isValidElement, type ReactNode, useEffect, useMemo, useState } from "react";
import { useTheme } from "../theme.ts";
import { translate } from "../tw/index.ts";
import { Box, collectAttrs } from "./box.tsx";
import { useInherited } from "./context.ts";

const CACHE_DIR = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "mirin-metal-ui",
  "images",
);
const inflight = new Map<string, Promise<string | null>>();

/** Resolve an image `src` to a local file path, downloading http(s) URLs once. */
export function resolveImage(src: string): Promise<string | null> {
  if (src.startsWith("/") && existsSync(src)) return Promise.resolve(src);
  if (src.startsWith("file://")) return Promise.resolve(src.slice(7));
  if (!/^https?:\/\//.test(src)) return Promise.resolve(null);
  const cached = inflight.get(src);
  if (cached) return cached;
  const job = (async () => {
    const hash = createHash("sha256").update(src).digest("hex").slice(0, 32);
    const ext = src.match(/\.(png|jpe?g|gif|webp|svg)(?:[?#]|$)/i)?.[1]?.toLowerCase() ?? "img";
    const path = join(CACHE_DIR, `${hash}.${ext}`);
    if (existsSync(path)) return path;
    try {
      const response = await fetch(src, { redirect: "follow" });
      if (!response.ok) return null;
      mkdirSync(CACHE_DIR, { recursive: true });
      await Bun.write(path, await response.arrayBuffer());
      return path;
    } catch {
      return null;
    }
  })();
  inflight.set(src, job);
  return job;
}

export function useImage(src: string | undefined): string | null {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!src) return;
    void resolveImage(src).then((resolved) => {
      if (live) setPath(resolved);
    });
    return () => {
      live = false;
    };
  }, [src]);
  return path;
}

export function HtmlImage(props: Record<string, unknown>) {
  const theme = useTheme();
  const src = typeof props.src === "string" ? props.src : undefined;
  const className = typeof props.className === "string" ? props.className : undefined;
  const path = useImage(src);
  const tw = useMemo(
    () =>
      translate(className, theme.colors, theme.radius, {
        attrs: collectAttrs(props),
        groups: {},
        dark: theme.mode === "dark",
        viewportWidth: theme.viewportWidth,
      }),
    [className, theme, props],
  );
  const numeric = (value: unknown) =>
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value) || undefined
        : undefined;
  const width = typeof tw.view.width === "number" ? tw.view.width : numeric(props.width);
  const height = typeof tw.view.height === "number" ? tw.view.height : numeric(props.height);
  const fills = tw.view.width === "100%" || tw.view.height === "100%" || props.fill === true;
  if (!path) {
    return (
      <Box
        viewStyle={{
          width: width ?? (fills ? "100%" : 40),
          height: height ?? (fills ? "100%" : 40),
          ...(tw.view.aspectRatio ? { aspectRatio: tw.view.aspectRatio } : {}),
          borderRadius: tw.view.borderRadius,
          backgroundColor: theme.colors.muted,
        }}
      />
    );
  }
  return (
    <Image
      source={path}
      resizeMode={tw.objectFit === "contain" ? "contain" : "cover"}
      style={{
        width,
        height,
        borderRadius: tw.view.borderRadius,
        opacity: tw.view.opacity,
        flex: fills ? 1 : undefined,
      }}
    />
  );
}

const SKIP_ATTRS = new Set(["children", "className", "__tag", "style", "ref", "key"]);

function kebab(name: string): string {
  if (name === "viewBox" || name.startsWith("data-") || name.startsWith("aria-")) return name;
  if (name === "xlinkHref") return "xlink:href";
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Serialize an SVG element tree (created through the JSX runtime) to markup. */
export function svgMarkup(tag: string, props: Record<string, unknown>): string {
  const attrs = Object.entries(props)
    .filter(([key, value]) => !SKIP_ATTRS.has(key) && value !== undefined && value !== false)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || value === true)
    .map(([key, value]) => `${kebab(key)}="${escape(String(value))}"`);
  if (tag === "svg" && !("xmlns" in props)) attrs.unshift('xmlns="http://www.w3.org/2000/svg"');
  const inner = svgChildren(props.children);
  return inner ? `<${tag} ${attrs.join(" ")}>${inner}</${tag}>` : `<${tag} ${attrs.join(" ")}/>`;
}

function svgChildren(children: unknown): string {
  const list = Array.isArray(children) ? children.flat(Number.POSITIVE_INFINITY) : [children];
  return list
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return escape(String(child));
      if (!isValidElement(child)) return "";
      const childProps = child.props as Record<string, unknown>;
      const tag =
        typeof childProps.__tag === "string"
          ? childProps.__tag
          : typeof child.type === "string"
            ? child.type
            : null;
      return tag ? svgMarkup(tag, childProps) : "";
    })
    .join("");
}

export function HtmlSvg(props: Record<string, unknown>) {
  const theme = useTheme();
  const inherited = useInherited();
  const className = typeof props.className === "string" ? props.className : undefined;
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
  const markup = useMemo(() => svgMarkup("svg", props), [props]);
  if (tw.hidden) return null;
  const numeric = (value: unknown) =>
    typeof value === "number" ? value : Number(value) || undefined;
  const size =
    (typeof tw.view.width === "number" ? tw.view.width : undefined) ??
    numeric(props.width) ??
    inherited.svg.size ??
    16;
  const height =
    (typeof tw.view.height === "number" ? tw.view.height : undefined) ??
    numeric(props.height) ??
    size;
  return (
    <Svg
      markup={markup}
      width={size}
      height={height}
      color={
        tw.text.color ?? inherited.svg.color ?? inherited.text.color ?? theme.colors.foreground
      }
      opacity={tw.view.opacity}
    />
  );
}

/** `<hr>`: a 1px rule in the border color. */
export function HtmlHr(props: Record<string, unknown>): ReactNode {
  return (
    <Box
      {...props}
      tag="hr"
      className={`h-px w-full shrink-0 bg-border ${typeof props.className === "string" ? props.className : ""}`}
    />
  );
}
