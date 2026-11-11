/** Internal host-instance tree the reconciler mutates between commits. */

import type { ImageProps, SvgProps, TextInputProps, TextProps, ViewProps } from "../types.ts";

export interface ViewInstance {
  kind: "view";
  /** Stable per-mount identity; keys press handlers across the boundary. */
  id: number;
  props: ViewProps;
  children: HostNode[];
}

export interface TextInstance {
  kind: "text";
  id: number;
  props: TextProps;
  children: HostNode[];
}

export interface InputInstance {
  kind: "input";
  id: number;
  props: TextInputProps;
  children: HostNode[];
}

/** A raw string/number child, e.g. the text inside `<Text>`. */
export interface RawTextInstance {
  kind: "raw";
  text: string;
}

export interface SvgInstance {
  kind: "svg";
  id: number;
  props: SvgProps;
  children: HostNode[];
}

export interface ImageInstance {
  kind: "image";
  id: number;
  props: ImageProps;
  children: HostNode[];
}

export type HostInstance =
  | ViewInstance
  | TextInstance
  | InputInstance
  | SvgInstance
  | ImageInstance;
export type HostNode = HostInstance | RawTextInstance;

export interface Container {
  children: HostNode[];
  /** Invoked after each commit; the renderer serializes and sends from here. */
  onCommit: () => void;
}

export function removeNode(list: HostNode[], child: HostNode): void {
  const index = list.indexOf(child);
  if (index >= 0) {
    list.splice(index, 1);
  }
}

export function insertNodeBefore(list: HostNode[], child: HostNode, before: HostNode): void {
  removeNode(list, child);
  const index = list.indexOf(before);
  if (index >= 0) {
    list.splice(index, 0, child);
  } else {
    list.push(child);
  }
}
