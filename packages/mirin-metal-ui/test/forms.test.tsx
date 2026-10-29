/**
 * Form behavior on the real ported examples: typing updates the library's
 * state, a `type="submit"` button outside the `<form>` (`form="<id>"`)
 * submits it, schema errors render, and a valid submit goes through.
 */

import { describe, expect, test } from "bun:test";
import { type ComponentType, useState } from "react";
import FormFormischDemo from "../demo/examples/form-formisch-demo.tsx";
import FormNextComplex from "../demo/examples/form-next-complex.tsx";
import FormNextDemo from "../demo/examples/form-next-demo.tsx";
import FormRhfDemo from "../demo/examples/form-rhf-demo.tsx";
import FormTanstackDemo from "../demo/examples/form-tanstack-demo.tsx";
import { Button } from "../src/components/button.tsx";
import { Checkbox } from "../src/components/checkbox.tsx";
import { Input } from "../src/components/input.tsx";
import { ThemeProvider } from "../src/provider.tsx";
import type { SyntheticEvent } from "../src/runtime/events.ts";
import { mount } from "./harness.ts";

const TITLE_ERROR = "Bug title must be at least 5 characters.";
const DESCRIPTION_ERROR = "Description must be at least 20 characters.";
const VALID_DESCRIPTION = "The login button does nothing when tapped.";

/** `prefix` is the inputs' id prefix (`<prefix>title`, `<prefix>description`). */
async function bugReport(Example: ComponentType, prefix: string, submitText = "Submit") {
  const h = await mount(
    <ThemeProvider>
      <Example />
    </ThemeProvider>,
  );
  // Invalid submit: both schema errors show.
  await h.type(`${prefix}title`, "Bug");
  await h.pressText(submitText);
  await Bun.sleep(30);
  await h.settle();
  expect(h.hasText(TITLE_ERROR)).toBe(true);
  expect(h.hasText(DESCRIPTION_ERROR)).toBe(true);
  // Fix the fields and resubmit: errors clear and the success toast shows.
  await h.type(`${prefix}title`, "Login broken");
  await h.type(`${prefix}description`, VALID_DESCRIPTION);
  await h.pressText(submitText);
  await Bun.sleep(30);
  await h.settle();
  return h;
}

describe("form examples", () => {
  test("react-hook-form: zod errors, then a valid submit", async () => {
    const h = await bugReport(FormRhfDemo, "form-rhf-demo-");
    expect(h.hasText(TITLE_ERROR)).toBe(false);
    expect(h.hasText("You submitted the following values:")).toBe(true);
    h.unmount();
  });

  test("tanstack form: zod errors, then a valid submit", async () => {
    const h = await bugReport(FormTanstackDemo, "");
    expect(h.hasText(TITLE_ERROR)).toBe(false);
    expect(h.hasText("You submitted the following values:")).toBe(true);
    h.unmount();
  });

  test("formisch: valibot errors, then a valid submit", async () => {
    const h = await bugReport(FormFormischDemo, "form-formisch-demo-");
    expect(h.hasText(TITLE_ERROR)).toBe(false);
    expect(h.hasText("You submitted the following values:")).toBe(true);
    h.unmount();
  });

  test("next/form + useActionState: the action gets FormData from named fields", async () => {
    const n = await mount(
      <ThemeProvider>
        <FormNextDemo />
      </ThemeProvider>,
    );
    await n.type("title", "Bug");
    await n.pressText("Submit");
    await Bun.sleep(30);
    await n.settle();
    expect(n.hasText(TITLE_ERROR)).toBe(true);
    expect(n.hasText(DESCRIPTION_ERROR)).toBe(true);
    // The uncontrolled fields keep the submitted values (the action echoes them back).
    expect(n.texts()).toContain("Bug");
    await n.type("title", "Login broken");
    await n.type("description", VALID_DESCRIPTION);
    await n.pressText("Submit");
    await Bun.sleep(30);
    await n.settle();
    expect(n.hasText(TITLE_ERROR)).toBe(false);
    expect(n.hasText("Thank you for your feedback")).toBe(true);
    // A successful action resets the fields to the new (empty) defaults.
    expect(n.texts()).not.toContain("Login broken");
    n.unmount();
  });

  test("next/form: radix radio, select, and checkbox values reach the action", async () => {
    const h = await mount(
      <ThemeProvider>
        <FormNextComplex />
      </ThemeProvider>,
    );
    await h.pressText("Save Preferences");
    // The action sleeps 1s before validating.
    await Bun.sleep(1200);
    await h.settle();
    expect(h.hasText("Please select at least one add-on")).toBe(true);
    // The radio group's and select's defaults were submitted.
    expect(h.hasText("Please select a subscription plan")).toBe(false);
    expect(h.hasText("Please select a billing period")).toBe(false);
    // Tick an add-on through its label and save again.
    await h.pressText("Backup");
    await h.pressText("Save Preferences");
    await Bun.sleep(1200);
    await h.settle();
    expect(h.hasText("Please select at least one add-on")).toBe(false);
    expect(h.hasText("Preferences saved")).toBe(true);
    h.unmount();
  });
});

describe("<form> runtime", () => {
  test("submit buttons inside and outside (form=id) submit with FormData; reset restores", async () => {
    const submitted: Array<Record<string, unknown>> = [];
    function Probe() {
      const [count, setCount] = useState(0);
      return (
        <>
          <form
            id="probe"
            onSubmit={(raw) => {
              const event = raw as unknown as SyntheticEvent;
              event.preventDefault();
              submitted.push({
                name: event.formData?.get("name"),
                agree: event.formData?.get("agree"),
                hidden: event.formData?.get("token"),
              });
              setCount(count + 1);
            }}
          >
            <Input id="name" name="name" defaultValue="Ada" />
            <Checkbox id="agree" name="agree" data-testid="agree" />
            <input type="hidden" name="token" value="t1" />
            <Button type="submit">Inside</Button>
            <Button type="reset">Clear</Button>
          </form>
          <Button type="submit" form="probe">
            Outside
          </Button>
          <p>{`count ${count}`}</p>
        </>
      );
    }
    const h = await mount(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await h.pressText("Inside");
    expect(submitted.at(-1)).toEqual({ name: "Ada", agree: null, hidden: "t1" });
    await h.type("name", "Grace");
    await h.press("agree");
    await h.pressText("Outside");
    expect(submitted.at(-1)).toEqual({ name: "Grace", agree: "on", hidden: "t1" });
    expect(h.hasText("count 2")).toBe(true);
    await h.pressText("Clear");
    expect(h.texts()).toContain("Ada");
    h.unmount();
  });
});
