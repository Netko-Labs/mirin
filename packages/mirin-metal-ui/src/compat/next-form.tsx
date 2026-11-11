/**
 * `next/form` on Metal: a `<form>` whose `action` runs on submit with the
 * form's named controls as `FormData` (the runtime's form registry stands in
 * for DOM serialization). Like React DOM's `<form action={fn}>`, the action
 * runs inside a transition (so `useActionState` dispatchers work) and the
 * form's uncontrolled fields reset to their (new) defaults once it settles.
 * Server actions run in-process: a `"use server"` function is just a function.
 * A string `action` (a URL to navigate to) is left to the form's default
 * submit, which on Metal goes nowhere: an app has no pages to load. Use a
 * function action, or `onSubmit`, to act on it.
 */

import { type ReactNode, useEffect, useRef, useTransition } from "react";
import type { SyntheticEvent } from "../runtime/events.ts";
import type { FormHandle } from "../runtime/form.tsx";

export interface FormProps {
  action?: string | ((formData: FormData) => void | Promise<void>);
  children?: ReactNode;
  className?: string;
  [prop: string]: unknown;
}

export default function Form({ action, children, ...props }: FormProps): ReactNode {
  const [isPending, startTransition] = useTransition();
  const handle = useRef<FormHandle | null>(null);
  const submitted = useRef(false);

  useEffect(() => {
    if (isPending || !submitted.current) return;
    submitted.current = false;
    handle.current?.reset();
  }, [isPending]);

  return (
    <form
      {...props}
      // The runtime's `<form>` hands its ref a FormHandle, not an HTMLFormElement.
      ref={handle as never}
      onSubmit={(raw) => {
        const event = raw as unknown as SyntheticEvent;
        if (typeof action !== "function") return;
        event.preventDefault();
        const formData = event.formData ?? new FormData();
        submitted.current = true;
        startTransition(async () => {
          await action(formData);
        });
      }}
    >
      {children}
    </form>
  );
}
