/**
 * Host components. Normal React usage:
 *
 *   <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
 *     <Text style={{ fontSize: 28 }}>hello</Text>
 *   </View>
 *
 * They resolve to the renderer's host element types; only this renderer can
 * mount them.
 */

import { createElement, type ReactElement } from "react";
import type { TextProps, ViewProps } from "./types.ts";

export const VIEW_TYPE = "mirin-view";
export const TEXT_TYPE = "mirin-text";

export function View(props: ViewProps): ReactElement {
  return createElement(VIEW_TYPE, props);
}

export function Text(props: TextProps): ReactElement {
  return createElement(TEXT_TYPE, props);
}
