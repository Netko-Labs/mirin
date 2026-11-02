/**
 * Nested routers on the wire (docs/api-design.md §3). A router can hold other
 * routers; each procedure is then named by its path, joined with dots
 * (`window.min`), which is the method name a request frame carries. Flat
 * routers keep their names as they were.
 *
 * The UI client and the main-process emitters are proxies that only know the
 * router's type, so inside a nested router a few names belong to them: on a
 * client node `on` subscribes, `then` would make it look like a promise, and
 * `apply`, `bind`, `call`, `toString` keep it a normal function; on an emitter
 * node `emit` and `broadcast` send. A nested router can't use those names.
 * Top-level names are not restricted, as before.
 */

import type { Procedure, Router } from "../rpc.ts";

export const SEPARATOR = ".";

export const RESERVED_NESTED_NAMES: ReadonlySet<string> = new Set([
  "on",
  "then",
  "emit",
  "broadcast",
  "apply",
  "bind",
  "call",
  "toString",
]);

const KINDS = new Set(["query", "mutation", "event"]);

export function isRouter(value: unknown): value is Router {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; routes?: unknown };
  return (
    candidate.type === "router" && typeof candidate.routes === "object" && candidate.routes !== null
  );
}

function isProcedure(value: unknown): value is Procedure {
  if (typeof value !== "object" || value === null) return false;
  return KINDS.has(String((value as { type?: unknown }).type));
}

/**
 * Every procedure of `router` by its full path. Throws on a value that is not
 * a procedure or a router, on two procedures with the same path (a flat
 * `"window.min"` beside a nested `window: { min }`), on a router that contains
 * itself, and on a reserved name inside a nested router.
 */
export function procedures(router: Router): Map<string, Procedure> {
  const found = new Map<string, Procedure>();
  const walk = (current: Router, prefix: string, open: Set<Router>): void => {
    open.add(current);
    for (const [name, value] of Object.entries(current.routes)) {
      const path = prefix === "" ? name : `${prefix}${SEPARATOR}${name}`;
      if (prefix !== "" && RESERVED_NESTED_NAMES.has(name)) {
        throw new Error(
          `rpc.router: "${path}" can't be used inside a nested router: ${[...RESERVED_NESTED_NAMES].join(", ")} are taken by the client and the event emitters. Rename it.`,
        );
      }
      if (isRouter(value)) {
        if (open.has(value)) throw new Error(`rpc.router: "${path}" contains itself`);
        walk(value, path, open);
        continue;
      }
      if (!isProcedure(value)) {
        throw new Error(
          `rpc.router: "${path}" is not a procedure or a router (use rpc.query, rpc.mutation, rpc.event, or rpc.router)`,
        );
      }
      if (found.has(path)) {
        throw new Error(
          `rpc.router: two procedures are named "${path}" (a nested router's procedures are named <router>${SEPARATOR}<procedure>). Rename one.`,
        );
      }
      found.set(path, value);
    }
    open.delete(current);
  };
  walk(router, "", new Set());
  return found;
}
