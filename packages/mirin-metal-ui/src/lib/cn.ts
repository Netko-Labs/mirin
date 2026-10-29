/**
 * `cn()` and `cva()` with the shapes shadcn code expects, so copied
 * components keep their variant tables verbatim. `cn` only joins (no
 * tailwind-merge: the translator applies classes in order, last wins).
 */

export type ClassValue = string | false | null | undefined | ClassValue[];

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const visit = (value: ClassValue) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    out.push(value);
  };
  for (const input of inputs) visit(input);
  return out.join(" ");
}

type VariantTable = Record<string, Record<string, string>>;

export interface CvaConfig<V extends VariantTable> {
  variants: V;
  defaultVariants?: { [K in keyof V]?: keyof V[K] };
}

export type VariantProps<T> = T extends (props?: infer P) => string ? P : never;

/** class-variance-authority, minus compound variants (unused by shadcn's core set). */
export function cva<V extends VariantTable>(base: string, config: CvaConfig<V>) {
  return (props?: { [K in keyof V]?: keyof V[K] | null } & { className?: string }): string => {
    const classes = [base];
    for (const key of Object.keys(config.variants) as Array<keyof V>) {
      const chosen = props?.[key] ?? config.defaultVariants?.[key];
      if (chosen !== undefined && chosen !== null) {
        classes.push(config.variants[key]?.[chosen as string] ?? "");
      }
    }
    if (props?.className) classes.push(props.className);
    return cn(...classes);
  };
}
