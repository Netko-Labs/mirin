/**
 * `cn()` and `cva()` with the shapes shadcn code expects, so copied
 * components keep their variant tables verbatim. `cn` joins (Tailwind
 * translation applies classes in order, so later classes win like
 * tailwind-merge's last-one-wins).
 */

export type ClassValue =
  | string
  | number
  | false
  | null
  | undefined
  | ClassValue[]
  | Record<string, unknown>;

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const visit = (value: ClassValue) => {
    if (!value && value !== 0) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value === "object") {
      for (const [key, on] of Object.entries(value)) if (on) out.push(key);
      return;
    }
    out.push(String(value));
  };
  for (const input of inputs) visit(input);
  return out.join(" ");
}

/** clsx-compatible alias. */
export const clsx = cn;

type VariantTable = Record<string, Record<string, string | string[]>>;

export interface CvaConfig<V extends VariantTable> {
  variants?: V;
  defaultVariants?: { [K in keyof V]?: keyof V[K] | boolean };
  compoundVariants?: Array<
    { [K in keyof V]?: keyof V[K] | Array<keyof V[K]> } & { class?: string; className?: string }
  >;
}

type VariantValue<T> = T extends "true" | "false" ? boolean : T;

export type VariantProps<T> = T extends (props?: infer P) => string
  ? { [K in keyof Omit<P, "class" | "className">]?: P[K] }
  : never;

/** class-variance-authority. */
export function cva<V extends VariantTable>(base: string | string[], config: CvaConfig<V> = {}) {
  return (
    props?: { [K in keyof V]?: VariantValue<keyof V[K]> | null } & {
      class?: string;
      className?: string;
    },
  ): string => {
    const variants = config.variants ?? ({} as V);
    const classes: ClassValue[] = [base];
    const chosen: Record<string, unknown> = {};
    for (const key of Object.keys(variants) as Array<keyof V & string>) {
      const value = props?.[key] ?? config.defaultVariants?.[key];
      if (value === undefined || value === null) continue;
      chosen[key] = String(value);
      classes.push(variants[key]?.[String(value)] ?? "");
    }
    for (const compound of config.compoundVariants ?? []) {
      const { class: cls, className, ...conditions } = compound;
      const matches = Object.entries(conditions).every(([key, want]) =>
        Array.isArray(want)
          ? want.map(String).includes(String(chosen[key]))
          : String(want) === chosen[key],
      );
      if (matches) classes.push(cls, className);
    }
    classes.push(props?.class, props?.className);
    return cn(...classes);
  };
}
