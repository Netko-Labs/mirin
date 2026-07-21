/**
 * react-reconciler host config (mutation mode): normal React — components,
 * hooks, state — drives this; commits mutate the host-instance tree and
 * `resetAfterCommit` hands the container back to the renderer for
 * serialization to the native side.
 */

import { createContext } from "react";
import type ReactReconciler from "react-reconciler";
import { DefaultEventPriority, NoEventPriority } from "react-reconciler/constants";
import { type TEXT_TYPE, VIEW_TYPE } from "../components.ts";
import type { TextProps, ViewProps } from "../types.ts";
import type { Container, HostInstance, HostNode, RawTextInstance } from "./instances.ts";
import { insertNodeBefore, removeNode } from "./instances.ts";

type HostType = typeof VIEW_TYPE | typeof TEXT_TYPE;
type HostProps = ViewProps | TextProps;
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
let currentUpdatePriority: number = NoEventPriority;

export const hostConfig: HostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: -1,

  createInstance(type, props) {
    const id = nextInstanceId++;
    // Type-only narrowing: the reconciler types props as the union across host
    // types, but the element type discriminates which props these are.
    return type === VIEW_TYPE
      ? { kind: "view", id, props: props as ViewProps, children: [] }
      : { kind: "text", id, props: props as TextProps, children: [] };
  },
  createTextInstance(text) {
    return { kind: "raw", text };
  },
  appendInitialChild(parent, child) {
    parent.children.push(child);
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
    container.onCommit();
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

  appendChild(parent, child) {
    removeNode(parent.children, child);
    parent.children.push(child);
  },
  appendChildToContainer(container, child) {
    removeNode(container.children, child);
    container.children.push(child);
  },
  insertBefore(parent, child, before) {
    insertNodeBefore(parent.children, child, before);
  },
  insertInContainerBefore(container, child, before) {
    insertNodeBefore(container.children, child, before);
  },
  removeChild(parent, child) {
    removeNode(parent.children, child);
  },
  removeChildFromContainer(container, child) {
    removeNode(container.children, child);
  },
  commitTextUpdate(textInstance, _oldText, newText) {
    textInstance.text = newText;
  },
  commitUpdate(instance, _type, _prevProps, nextProps) {
    instance.props = nextProps;
  },
  clearContainer(container) {
    container.children.length = 0;
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
