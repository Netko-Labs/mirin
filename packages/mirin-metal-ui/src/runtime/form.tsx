/**
 * `<form>` semantics without a DOM: named controls register their current
 * value so submit can hand the handler a populated `FormData`
 * (`event.formData`), `type="submit"` buttons (inside, or outside with
 * `form="<id>"`) submit, `type="reset"` buttons reset, and `ref` receives a
 * form-element-shaped handle (`requestSubmit`, `submit`, `reset`).
 */

import { type ReactNode, type Ref, useContext, useEffect, useMemo, useRef } from "react";
import { type FormApi, FormContext, type FormField } from "./context.ts";
import { type SyntheticEvent, syntheticEvent } from "./events.ts";

/** Mounted forms by `id`, for buttons that point at one with `form="<id>"`. */
const formsById = new Map<string, FormApi>();

/** The form a submit/reset button acts on: `form="<id>"` wins over the enclosing one. */
export function resolveForm(enclosing: FormApi | null, formId: unknown): FormApi | null {
  if (typeof formId === "string" && formId) return formsById.get(formId) ?? null;
  return enclosing;
}

export interface FormHandle {
  requestSubmit: () => void;
  submit: () => void;
  reset: () => void;
}

interface FormScopeProps {
  id?: string;
  onSubmit?: (event: SyntheticEvent) => void;
  onReset?: (event: SyntheticEvent) => void;
  formRef?: Ref<FormHandle>;
  children: ReactNode;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref && typeof ref === "object") (ref as { current: T | null }).current = value;
}

export function FormScope({ id, onSubmit, onReset, formRef, children }: FormScopeProps): ReactNode {
  const fields = useRef(new Map<symbol, FormField>());
  const handlers = useRef({ onSubmit, onReset });
  handlers.current = { onSubmit, onReset };

  const api = useMemo<FormApi>(() => {
    const formData = (): FormData => {
      const data = new FormData();
      for (const field of fields.current.values()) {
        if (!field.name) continue;
        const value = field.value();
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) data.append(field.name, item);
      }
      return data;
    };
    return {
      submit: () => {
        const event = syntheticEvent("submit");
        event.formData = formData();
        handlers.current.onSubmit?.(event);
      },
      reset: () => {
        const event = syntheticEvent("reset");
        handlers.current.onReset?.(event);
        if (event.defaultPrevented) return;
        for (const field of fields.current.values()) field.reset?.();
      },
      register: (field) => {
        const key = Symbol(field.name);
        fields.current.set(key, field);
        return () => fields.current.delete(key);
      },
      formData,
    };
  }, []);

  useEffect(() => {
    if (!id) return;
    formsById.set(id, api);
    return () => {
      if (formsById.get(id) === api) formsById.delete(id);
    };
  }, [id, api]);

  useEffect(() => {
    if (!formRef) return;
    assignRef<FormHandle>(formRef, {
      requestSubmit: api.submit,
      submit: api.submit,
      reset: api.reset,
    });
    return () => assignRef<FormHandle>(formRef, null);
  }, [formRef, api]);

  return <FormContext.Provider value={api}>{children}</FormContext.Provider>;
}

/**
 * Register a named control's current value with the enclosing `<form>`
 * (what a DOM form would serialize). `value` is read at submit time;
 * `undefined` contributes nothing (an unchecked checkbox). `reset` restores
 * the control's default.
 */
export function useFormField(
  name: string | undefined,
  value: string | string[] | undefined,
  reset?: () => void,
): void {
  const form = useContext(FormContext);
  const latest = useRef({ value, reset });
  latest.current = { value, reset };
  useEffect(() => {
    if (!form || !name) return;
    return form.register({
      name,
      value: () => latest.current.value,
      reset: () => latest.current.reset?.(),
    });
  }, [form, name]);
}
