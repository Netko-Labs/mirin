/**
 * Host components. Normal React usage:
 *
 *   <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
 *     <Text style={{ fontSize: 28 }}>hello</Text>
 *     <TextInput value={sql} onChangeText={setSql} multiline />
 *   </View>
 *
 * They resolve to the renderer's host element types; only this renderer can
 * mount them.
 */

import { createElement, type ReactElement } from "react";
import type { TextInputProps, TextProps, ViewProps } from "./types.ts";

export const VIEW_TYPE = "mirin-view";
export const TEXT_TYPE = "mirin-text";
export const INPUT_TYPE = "mirin-input";

export function View(props: ViewProps): ReactElement {
  return createElement(VIEW_TYPE, props);
}

export function Text(props: TextProps): ReactElement {
  return createElement(TEXT_TYPE, props);
}

export function TextInput(props: TextInputProps): ReactElement {
  return createElement(INPUT_TYPE, props);
}

/** A vertically scrolling `<View>`. */
export function ScrollView(props: ViewProps): ReactElement {
  return createElement(VIEW_TYPE, {
    ...props,
    style: { ...props.style, overflow: "scroll" },
  });
}
