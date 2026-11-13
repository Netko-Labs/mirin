/**
 * Host components. Normal React usage:
 *
 *   <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
 *     <Text style={{ fontSize: 28 }}>hello</Text>
 *     <TextInput value={sql} onChangeText={setSql} multiline />
 *   </View>
 *
 * They resolve to the renderer's host element types; only this renderer can
 * mount them. Each hands its props object to its host element as it is
 * (`jsx`; `createElement` copied every element's props once more): the
 * element React compares and the host instance holds is the one the app
 * wrote.
 */

import { createContext, type ReactElement, useContext } from "react";
import { jsx } from "react/jsx-runtime";
import type {
  ImageProps,
  SvgProps,
  TextInputDefaultProps,
  TextInputProps,
  TextProps,
  ViewProps,
} from "./types.ts";

export const VIEW_TYPE = "mirin-view";
export const TEXT_TYPE = "mirin-text";
export const INPUT_TYPE = "mirin-input";
export const SVG_TYPE = "mirin-svg";
export const IMAGE_TYPE = "mirin-image";

/**
 * React's `jsx` for a host type of this renderer. Type-only cast: React's
 * types take DOM tags and components, not another renderer's type names.
 */
const host = jsx as unknown as (type: string, props: object) => ReactElement;

export function View(props: ViewProps): ReactElement {
  return host(VIEW_TYPE, props);
}

export function Text(props: TextProps): ReactElement {
  return host(TEXT_TYPE, props);
}

/**
 * Props every `<TextInput>` below it takes unless it passes its own, as a theme gives
 * them: `<TextInputDefaults.Provider value={{ selectionColor }}>`.
 */
export const TextInputDefaults = createContext<TextInputDefaultProps>({});

export function TextInput(props: TextInputProps): ReactElement {
  const defaults = useContext(TextInputDefaults);
  const selectionColor = props.selectionColor ?? defaults.selectionColor;
  return host(INPUT_TYPE, selectionColor === undefined ? props : { ...props, selectionColor });
}

/** A vertically scrolling `<View>`. */
export function ScrollView(props: ViewProps): ReactElement {
  return host(VIEW_TYPE, {
    ...props,
    style: { ...props.style, overflow: "scroll" },
  });
}

/** A vector icon from inline SVG markup, tinted with `color`. */
export function Svg(props: SvgProps): ReactElement {
  return host(SVG_TYPE, props);
}

/** A raster image from a local file. */
export function Image(props: ImageProps): ReactElement {
  return host(IMAGE_TYPE, props);
}
