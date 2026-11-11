/**
 * react-reconciler host config (mutation mode): normal React — components,
 * hooks, state — drives this; commits mutate the host-instance tree, each
 * change is logged (`lib/commit-log.ts`), and `resetAfterCommit` hands the
 * container back to the renderer, which sends the native side what changed.
 */

import { createContext } from "react";
import type ReactReconciler from "react-reconciler";
import { DefaultEventPriority, NoEventPriority } from "react-reconciler/constants";
import { IMAGE_TYPE, INPUT_TYPE, SVG_TYPE, TEXT_TYPE, VIEW_TYPE } from "../components.ts";

const TEXT_TYPE_NAME: string = TEXT_TYPE;
const warnedHosts = new Set<string>();
function warnUnknownHost(type: string): void {
  if (warnedHosts.has(type)) return;
  warnedHosts.add(type);
  console.warn(`[mirin-metal] unknown host type "${type}" rendered as a view`);
}

import type { ImageProps, SvgProps, TextInputProps, TextProps, ViewProps } from "../types.ts";
import { logDirty, logMutation, sameProps } from "./commit-log.ts";
import type {
  Container,
  HostInstance,
  HostNode,
  HostParent,
  RawTextInstance,
} from "./instances.ts";
import { forgetHints, insertNodeBefore, removeNode } from "./instances.ts";
import { committed } from "./rest.ts";

type HostType =
  | typeof VIEW_TYPE
  | typeof TEXT_TYPE
  | typeof INPUT_TYPE
  | typeof SVG_TYPE
  | typeof IMAGE_TYPE;
type HostProps = ViewProps | TextProps | TextInputProps | SvgProps | ImageProps;
/** Sentinel: React requires a non-null host context even when unused. */
type HostContext = Record<string, never>;
const HOST_CONTEXT: HostContext = {};

export type HostConfig = ReactReconciler.HostConfig<
  HostType,
  HostProps,
  Container,
  HostInstance,
  RawTextInstance,
  never, // SuspenseInstance
  never, // HydratableInstance
  never, // FormInstance
  HostNode, // PublicInstance
  HostContext, // HostContext
  never, // ChildSet
  ReturnType<typeof setTimeout>,
  -1, // NoTimeout
  null // TransitionStatus
>;

let nextInstanceId = 1;
/** Strings get their own ids ("r1", …), so the instances' numbers stay what they always were. */
let nextTextId = 1;

function place(parent: HostParent, child: HostNode, before: HostNode | null): void {
  child.parent = parent;
  logMutation({ kind: "place", parent, child, before });
}

function remove(parent: HostParent, child: HostNode): void {
  removeNode(parent.children, child);
  child.parent = null;
  logMutation({ kind: "remove", parent, child });
}
let currentUpdatePriority: number = NoEventPriority;

export const hostConfig: HostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: -1,

  createInstance(type, props) {
    const id = nextInstanceId++;
    const base = { id, key: String(id), children: [], parent: null };
    // Type-only narrowing: the reconciler types props as the union across host
    // types, but the element type discriminates which props these are.
    if (type === VIEW_TYPE) return { kind: "view", props: props as ViewProps, ...base };
    if (type === INPUT_TYPE) return { kind: "input", props: props as TextInputProps, ...base };
    if (type === SVG_TYPE) return { kind: "svg", props: props as SvgProps, ...base };
    if (type === IMAGE_TYPE) return { kind: "image", props: props as ImageProps, ...base };
    if (type === TEXT_TYPE_NAME) return { kind: "text", props: props as TextProps, ...base };
    // An unknown host type (e.g. a library rendering "form" with React's own
    // JSX runtime): keep its children visible as a plain view.
    warnUnknownHost(type);
    return { kind: "view", props: {} as ViewProps, ...base };
  },
  createTextInstance(text) {
    return { kind: "raw", text, key: `r${nextTextId++}`, parent: null };
  },
  appendInitialChild(parent, child) {
    parent.children.push(child);
    child.parent = parent;
  },
  finalizeInitialChildren() {
    return false;
  },
  shouldSetTextContent() {
    return false;
  },
  getRootHostContext() {
    return HOST_CONTEXT;
  },
  getChildHostContext(parentHostContext) {
    return parentHostContext;
  },
  getPublicInstance(instance) {
    return instance;
  },
  prepareForCommit() {
    return null;
  },
  resetAfterCommit(container) {
    forgetHints();
    container.onCommit();
    committed();
  },
  preparePortalMount() {},
  scheduleTimeout(fn, delay) {
    return setTimeout(fn, delay);
  },
  cancelTimeout(id) {
    clearTimeout(id);
  },
  getInstanceFromNode() {
    return null;
  },
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
  prepareScopeUpdate() {},
  getInstanceFromScope() {
    return null;
  },
  detachDeletedInstance() {},

  // A portal's container is a mounted instance; the root's is a Container.
  // A child whose parent this already is, is being moved: it leaves its old
  // place first. A new one is in no list, so none is searched for it.
  appendChild(parent, child) {
    if (child.parent === parent) removeNode(parent.children, child);
    parent.children.push(child);
    place(parent, child, null);
  },
  appendChildToContainer(container, child) {
    if (child.parent === container) removeNode(container.children, child);
    container.children.push(child);
    place(container, child, null);
  },
  insertBefore(parent, child, before) {
    insertNodeBefore(parent.children, child, before, child.parent === parent);
    place(parent, child, before);
  },
  insertInContainerBefore(container, child, before) {
    insertNodeBefore(container.children, child, before, child.parent === container);
    place(container, child, before);
  },
  removeChild(parent, child) {
    remove(parent, child);
  },
  removeChildFromContainer(container, child) {
    remove(container, child);
  },
  commitTextUpdate(textInstance, _oldText, newText) {
    textInstance.text = newText;
    logDirty(textInstance);
  },
  commitUpdate(instance, _type, prevProps, nextProps) {
    instance.props = nextProps;
    // A new props object every render; only a change that may be sent is logged.
    if (!sameProps(prevProps, nextProps)) logDirty(instance);
  },
  clearContainer(container) {
    for (const child of [...container.children]) remove(container, child);
  },

  NotPendingTransition: null,
  // Type-only cast: the reconciler wants its own ReactContext declaration,
  // which structurally mismatches react's Context type; runtime shape is the
  // same createContext object.
  HostTransitionContext: createContext<null>(
    null,
  ) as unknown as HostConfig["HostTransitionContext"],
  setCurrentUpdatePriority(newPriority) {
    currentUpdatePriority = newPriority;
  },
  getCurrentUpdatePriority() {
    return currentUpdatePriority;
  },
  resolveUpdatePriority() {
    return currentUpdatePriority !== NoEventPriority ? currentUpdatePriority : DefaultEventPriority;
  },
  resetFormInstance() {},
  requestPostPaintCallback() {},
  shouldAttemptEagerTransition() {
    return false;
  },
  trackSchedulerEvent() {},
  resolveEventType() {
    return null;
  },
  resolveEventTimeStamp() {
    return -1.1;
  },
  maySuspendCommit() {
    return false;
  },
  preloadInstance() {
    return true;
  },
  startSuspendingCommit() {},
  suspendInstance() {},
  waitForCommitToBeReady() {
    return null;
  },
};
