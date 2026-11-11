import type * as React from "react";
import * as v from "valibot";
import type { SubmitHandler } from "../../src/compat/formisch.tsx";
import { Form, Field as FormischField, reset, useForm } from "../../src/compat/formisch.tsx";
import { Button } from "../../src/components/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../src/components/card.tsx";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../../src/components/field.tsx";
import { toast } from "../../src/components/sonner.tsx";
import { Switch } from "../../src/components/switch.tsx";

const FormSchema = v.object({
  twoFactor: v.pipe(
    v.boolean(),
    v.check(
      (value) => value === true,
      "It is highly recommended to enable two-factor authentication.",
    ),
  ),
});

export default function FormFormischSwitch() {
  const form = useForm({
    schema: FormSchema,
    initialInput: {
      twoFactor: false,
    },
  });

  const handleSubmit: SubmitHandler<typeof FormSchema> = (output) => {
    toast("You submitted the following values:", {
      description: (
        <pre className="mt-2 w-[320px] overflow-x-auto rounded-md bg-code p-4 text-code-foreground">
          <code>{JSON.stringify(output, null, 2)}</code>
        </pre>
      ),
      position: "bottom-right",
      classNames: {
        content: "flex flex-col gap-2",
      },
      style: {
        "--border-radius": "calc(var(--radius)  + 4px)",
      } as React.CSSProperties,
    });
  };

  return (
    <Card className="w-full sm:max-w-md">
      <CardHeader>
        <CardTitle>Security Settings</CardTitle>
        <CardDescription>Manage your account security preferences.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form of={form} id="form-formisch-switch" onSubmit={handleSubmit}>
          <FieldGroup>
            <FormischField of={form} path={["twoFactor"]}>
              {(field) => (
                <Field orientation="horizontal" data-invalid={field.errors !== null}>
                  <FieldContent>
                    <FieldLabel htmlFor="form-formisch-switch-twoFactor">
                      Multi-factor authentication
                    </FieldLabel>
                    <FieldDescription>
                      Enable multi-factor authentication to secure your account.
                    </FieldDescription>
                    {field.errors && (
                      <FieldError errors={field.errors.map((message) => ({ message }))} />
                    )}
                  </FieldContent>
                  <Switch
                    id="form-formisch-switch-twoFactor"
                    checked={field.input ?? false}
                    onCheckedChange={(checked) => field.onChange(checked)}
                    aria-invalid={field.errors !== null}
                  />
                </Field>
              )}
            </FormischField>
          </FieldGroup>
        </Form>
      </CardContent>
      <CardFooter>
        <Field orientation="horizontal">
          <Button type="button" variant="outline" onClick={() => reset(form)}>
            Reset
          </Button>
          <Button type="submit" form="form-formisch-switch">
            Save
          </Button>
        </Field>
      </CardFooter>
    </Card>
  );
}
