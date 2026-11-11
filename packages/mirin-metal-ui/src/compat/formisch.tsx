/**
 * `@formisch/react` on Metal. Everything is the real library except `Form`,
 * which upstream renders through React DOM's JSX runtime (a raw `<form>` host
 * Metal does not know). This `Form` renders metal-ui's `<form>` and hands
 * formisch a form-element handle so `submit(form)` (`requestSubmit`) works.
 */

import type { FormProps, FormSchema, SubmitHandler } from "@formisch/react";
import { handleSubmit } from "@formisch/react";
import { INTERNAL } from "@formisch/react/internals";
import type { ReactNode } from "react";
import type { FormHandle } from "../runtime/form.tsx";

export * from "@formisch/react";

export function Form<TSchema extends FormSchema>({
  of,
  onSubmit,
  ...other
}: FormProps<TSchema>): ReactNode {
  // Upstream's runtime handler also receives the submit event; its public type omits it.
  const submit = handleSubmit(of, onSubmit as SubmitHandler<TSchema>) as (
    event: unknown,
  ) => Promise<void>;
  return (
    <form
      {...(other as Record<string, unknown>)}
      noValidate
      ref={(handle: FormHandle | null) => {
        // formisch only calls `requestSubmit()` on the stored element.
        if (handle) (of[INTERNAL] as { element?: unknown }).element = handle;
      }}
      onSubmit={(event: unknown) => {
        void submit(event);
      }}
    />
  );
}
