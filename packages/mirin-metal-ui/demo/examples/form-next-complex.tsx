import * as React from "react";
import Form from "../../src/compat/next-form.tsx";
import { Button } from "../../src/components/button.tsx";
import { Card, CardContent, CardFooter } from "../../src/components/card.tsx";
import { Checkbox } from "../../src/components/checkbox.tsx";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "../../src/components/field.tsx";
import { RadioGroup, RadioGroupItem } from "../../src/components/radio-group.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../src/components/select.tsx";
import { toast } from "../../src/components/sonner.tsx";
import { Spinner } from "../../src/components/spinner.tsx";
import { Switch } from "../../src/components/switch.tsx";

import { complexFormAction } from "./form-next-complex-action.ts";
import { addons, type FormState } from "./form-next-complex-schema.ts";

export default function FormNextComplex() {
  const [formState, formAction, pending] = React.useActionState<FormState, FormData>(
    complexFormAction,
    {
      values: {
        plan: "basic",
        billingPeriod: "monthly",
        addons: [],
        emailNotifications: false,
      },
      errors: null,
      success: false,
    },
  );

  React.useEffect(() => {
    if (formState.success) {
      toast.success("Preferences saved", {
        description: "Your subscription plan has been updated.",
      });
    }
  }, [formState.success]);

  return (
    <Card className="w-full max-w-sm">
      <CardContent>
        <Form action={formAction} id="subscription-form">
          <FieldGroup>
            <FieldSet data-invalid={!!formState.errors?.plan?.length}>
              <FieldLegend>Subscription Plan</FieldLegend>
              <FieldDescription>Choose your subscription plan.</FieldDescription>
              <RadioGroup
                name="plan"
                defaultValue={formState.values.plan}
                disabled={pending}
                aria-invalid={!!formState.errors?.plan?.length}
              >
                <FieldLabel htmlFor="basic">
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>Basic</FieldTitle>
                      <FieldDescription>For individuals and small teams</FieldDescription>
                    </FieldContent>
                    <RadioGroupItem value="basic" id="basic" />
                  </Field>
                </FieldLabel>
                <FieldLabel htmlFor="pro">
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>Pro</FieldTitle>
                      <FieldDescription>For businesses with higher demands</FieldDescription>
                    </FieldContent>
                    <RadioGroupItem value="pro" id="pro" />
                  </Field>
                </FieldLabel>
              </RadioGroup>
              {formState.errors?.plan && <FieldError>{formState.errors.plan[0]}</FieldError>}
            </FieldSet>
            <FieldSeparator />
            <Field data-invalid={!!formState.errors?.billingPeriod?.length}>
              <FieldLabel htmlFor="billingPeriod">Billing Period</FieldLabel>
              <Select
                name="billingPeriod"
                defaultValue={formState.values.billingPeriod}
                disabled={pending}
                aria-invalid={!!formState.errors?.billingPeriod?.length}
              >
                <SelectTrigger id="billingPeriod">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="yearly">Yearly</SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>Choose how often you want to be billed.</FieldDescription>
              {formState.errors?.billingPeriod && (
                <FieldError>{formState.errors.billingPeriod[0]}</FieldError>
              )}
            </Field>
            <FieldSeparator />
            <FieldSet>
              <FieldLegend>Add-ons</FieldLegend>
              <FieldDescription>
                Select additional features you&apos;d like to include.
              </FieldDescription>
              <FieldGroup data-slot="checkbox-group">
                {addons.map((addon) => (
                  <Field
                    key={addon.id}
                    orientation="horizontal"
                    data-invalid={!!formState.errors?.addons?.length}
                  >
                    <Checkbox
                      id={addon.id}
                      name="addons"
                      value={addon.id}
                      defaultChecked={formState.values.addons.includes(addon.id)}
                      disabled={pending}
                      aria-invalid={!!formState.errors?.addons?.length}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor={addon.id}>{addon.title}</FieldLabel>
                      <FieldDescription>{addon.description}</FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </FieldGroup>
              {formState.errors?.addons && <FieldError>{formState.errors.addons[0]}</FieldError>}
            </FieldSet>
            <FieldSeparator />
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="emailNotifications">Email Notifications</FieldLabel>
                <FieldDescription>Receive email updates about your subscription</FieldDescription>
              </FieldContent>
              <Switch
                id="emailNotifications"
                name="emailNotifications"
                defaultChecked={formState.values.emailNotifications}
                disabled={pending}
                aria-invalid={!!formState.errors?.emailNotifications?.length}
              />
            </Field>
          </FieldGroup>
        </Form>
      </CardContent>
      <CardFooter>
        <Field orientation="horizontal" className="justify-end">
          <Button type="submit" disabled={pending} form="subscription-form">
            {pending && <Spinner />}
            Save Preferences
          </Button>
        </Field>
      </CardFooter>
    </Card>
  );
}
