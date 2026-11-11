/** `next/link` on Metal: an `<a>` that opens http(s) links externally. */

import type { ReactNode } from "react";

export interface LinkProps {
  href: string | { pathname?: string };
  children?: ReactNode;
  className?: string;
  [prop: string]: unknown;
}

export default function Link({ href, children, ...props }: LinkProps) {
  const target = typeof href === "string" ? href : (href.pathname ?? "#");
  return (
    <a href={target} {...props}>
      {children}
    </a>
  );
}
