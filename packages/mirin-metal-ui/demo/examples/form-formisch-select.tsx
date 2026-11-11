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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../../src/components/select.tsx";
import { toast } from "../../src/components/sonner.tsx";

const spokenLanguages = [
  { label: "English", value: "en" },
  { label: "Spanish", value: "es" },
  { label: "French", value: "fr" },
  { label: "German", value: "de" },
  { label: "Italian", value: "it" },
  { label: "Chinese", value: "zh" },
  { label: "Japanese", value: "ja" },
] as const;

const FormSchema = v.object({
  language: v.pipe(
    v.string(),
    v.minLength(1, "Please select your spoken language."),
    v.check(
      (value) => value !== "auto",
      "Auto-detection is not allowed. Please select a specific language.",
    ),
  ),
});

export default function FormFormischSelect() {
  const form = useForm({
    schema: FormSchema,
    initialInput: {
      language: "",
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
    <Card className="w-full sm:max-w-lg">
      <CardHeader>
        <CardTitle>Language Preferences</CardTitle>
        <CardDescription>Select your preferred spoken language.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form of={form} id="form-formisch-select" onSubmit={handleSubmit}>
          <FieldGroup>
            <FormischField of={form} path={["language"]}>
              {(field) => (
                <Field orientation="responsive" data-invalid={field.errors !== null}>
                  <FieldContent>
                    <FieldLabel htmlFor="form-formisch-select-language">Spoken Language</FieldLabel>
                    <FieldDescription>
                      For best results, select the language you speak.
                    </FieldDescription>
                    {field.errors && (
                      <FieldError errors={field.errors.map((message) => ({ message }))} />
                    )}
                  </FieldContent>
                  <Select
                    value={field.input ?? ""}
                    onValueChange={(value) => field.onChange(value)}
                  >
                    <SelectTrigger
                      id="form-formisch-select-language"
                      aria-invalid={field.errors !== null}
                      className="min-w-[120px]"
                    >
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent position="item-aligned">
                      <SelectItem value="auto">Auto</SelectItem>
                      <SelectSeparator />
                      {spokenLanguages.map((language) => (
                        <SelectItem key={language.value} value={language.value}>
                          {language.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
          <Button type="submit" form="form-formisch-select">
            Save
          </Button>
        </Field>
      </CardFooter>
    </Card>
  );
}
