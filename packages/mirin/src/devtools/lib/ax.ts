/**
 * Accessibility-tree formatting: `Accessibility.getFullAXTree` → compact indented
 * text. Roles and names without markup noise — a 100 KB outerHTML usually
 * snapshots to a few hundred bytes.
 */

import { asArray, asBoolean, asRecord, asString } from "./parse.ts";

/** Two spaces per level, like the DOM inspectors people already read. */
const INDENT = "  ";

/** Cap the output so one enormous page cannot swamp a reader. */
const MAX_LINES = 600;

/** Guard against a pathological or cyclic tree. */
const MAX_DEPTH = 40;

/** Properties worth showing; the rest is derived, always present, or noise. */
const KEPT_PROPERTIES = new Set([
  "level",
  "checked",
  "disabled",
  "expanded",
  "focused",
  "invalid",
  "modal",
  "multiselectable",
  "pressed",
  "readonly",
  "required",
  "selected",
]);

/** Roles that carry no information on their own once their children are shown. */
const SKIPPED_ROLES = new Set(["none", "presentation", "generic", "InlineTextBox"]);

interface AxNode {
  id: string;
  role: string;
  name: string;
  value: string;
  ignored: boolean;
  properties: string[];
  childIds: string[];
}

/** `{ value: { value: x } }` is the shape CDP uses for nearly every AX field. */
function innerValue(value: unknown): unknown {
  return asRecord(value)?.value;
}

function scalarText(value: unknown): string {
  const inner = innerValue(value);
  if (typeof inner === "string") return inner;
  if (typeof inner === "number" || typeof inner === "boolean") return String(inner);
  return "";
}

/** Render one AX property as `name` (for true) or `name=value`. */
function formatProperty(entry: unknown): string | undefined {
  const record = asRecord(entry);
  const name = asString(record?.name);
  if (name === undefined || !KEPT_PROPERTIES.has(name)) return undefined;
  const inner = innerValue(record?.value);
  if (inner === false || inner === "false" || inner === undefined || inner === null)
    return undefined;
  // A bare flag reads better than `checked=true`.
  if (inner === true || inner === "true") return name;
  return `${name}=${String(inner)}`;
}

function parseNode(value: unknown): AxNode | undefined {
  const record = asRecord(value);
  const id = asString(record?.nodeId);
  if (record === undefined || id === undefined) return undefined;
  return {
    id,
    role: scalarText(record.role),
    name: scalarText(record.name),
    value: scalarText(record.value),
    ignored: asBoolean(record.ignored) === true,
    properties: (asArray(record.properties) ?? []).flatMap((entry) => formatProperty(entry) ?? []),
    childIds: (asArray(record.childIds) ?? []).flatMap((child) => asString(child) ?? []),
  };
}

/** One line for a node: role, quoted name, value, then flags. */
function formatLine(node: AxNode, depth: number): string {
  const parts = [node.role.length > 0 ? node.role : "node"];
  if (node.name.length > 0) parts.push(JSON.stringify(node.name));
  if (node.value.length > 0) parts.push(`value=${JSON.stringify(node.value)}`);
  parts.push(...node.properties);
  return `${INDENT.repeat(depth)}${parts.join(" ")}`;
}

/** Format the flat node list CDP returns as an indented tree. Meaningless nodes
 *  are elided with their children kept at the parent's depth, so a button wrapped
 *  in four divs prints as one line. */
export function formatAxTree(payload: unknown): string {
  const nodes = (asArray(asRecord(payload)?.nodes) ?? []).flatMap(
    (entry) => parseNode(entry) ?? [],
  );
  if (nodes.length === 0) return "";

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childIds = new Set(nodes.flatMap((node) => node.childIds));
  const roots = nodes.filter((node) => !childIds.has(node.id));

  const lines: string[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const walk = (node: AxNode, depth: number): void => {
    if (truncated || depth > MAX_DEPTH) return;
    // The tree is a DAG in principle; a visited set makes a cycle harmless.
    if (seen.has(node.id)) return;
    seen.add(node.id);

    const hidden = node.ignored || SKIPPED_ROLES.has(node.role);
    if (!hidden) {
      if (lines.length >= MAX_LINES) {
        truncated = true;
        return;
      }
      lines.push(formatLine(node, depth));
    }

    const childDepth = hidden ? depth : depth + 1;
    for (const childId of node.childIds) {
      const child = byId.get(childId);
      if (child !== undefined) walk(child, childDepth);
    }
  };

  for (const root of roots.length > 0 ? roots : nodes.slice(0, 1)) walk(root, 0);

  if (truncated) lines.push(`… snapshot truncated at ${MAX_LINES} nodes`);
  return lines.join("\n");
}
