import type { WindowConfig } from "../config/index.ts";
import type { EventProc, Router } from "../rpc.ts";

/** Which native backend a window's `material` resolved to. */
export type WindowMaterialInfo = {
  /** The material that was requested. */
  requested: string;
  /** What actually rendered: real Liquid Glass, a vibrancy material, or none. */
  backend: "liquidGlass" | "vibrancy" | "none";
  /** Whether Apple's Liquid Glass (NSGlassEffectView, macOS 26+) is available. */
  liquidGlassAvailable: boolean;
};

export type WindowEvents = {
  focus: void;
  blur: void;
  moved: void;
  resized: void;
  closed: void;
  /** Fired when a native background material is applied (see setMaterial). */
  material: WindowMaterialInfo;
};

export type AppEvents = {
  ready: void;
  "window-all-closed": void;
  /** A deep-link URL (a registered `urlSchemes` scheme) opened the app, or
   *  arrived while it was running. Includes the launch URL. */
  "open-url": string;
};

/** A window's frame in screen points (bottom-left origin, like AppKit). */
export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowOpenOptions extends WindowConfig {
  name?: string;
}

/** Typed push emitters derived from a router's `event` procedures.
 * Type-level `any` keeps the caller's router payload inference intact. */
export type BroadcastEmitters<R extends Router<any>> = R extends Router<infer T>
  ? {
      [K in keyof T as T[K] extends EventProc<any> ? K : never]: T[K] extends EventProc<infer P>
        ? { broadcast(payload: P): void }
        : never;
    }
  : never;

/** Type-level `any` preserves the caller's concrete router shape. */
export interface ServeHandle<R extends Router<any>> {
  readonly rpc: BroadcastEmitters<R>;
}

/** macOS Dock-icon controls (no-ops off macOS). */
export interface Dock {
  /** Hide the Dock icon and menu-bar presence (agent/accessory app). */
  hide(): void;
  /** Restore the Dock icon and menu bar. */
  show(): void;
}
