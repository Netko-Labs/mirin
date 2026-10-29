/**
 * `next/form` on Metal: a `<form>` whose `action` runs on submit with the
 * form's fields as `FormData` (collected from named controls by the caller's
 * own state; Metal has no DOM form serialization, so it is empty unless the
 * caller fills it).
 */

import type { ReactNode } from "react";

export interface FormProps {
  action?: string | ((formData: FormData) => void | Promise<void>);
  children?: ReactNode;
  className?: string;
  [prop: string]: unknown;
}

export default function Form({ action, children, ...props }: FormProps) {
  return (
    <form
      {...props}
      onSubmit={(event: { preventDefault: () => void }) => {
        event.preventDefault();
        if (typeof action === "function") void action(new FormData());
      }}
    >
      {children}
    </form>
  );
}
