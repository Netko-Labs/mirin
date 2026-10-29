import { zodResolver } from "@hookform/resolvers/zod";
import type * as React from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import * as z from "zod";
import { Button } from "../../src/components/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../src/components/card.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "../../src/components/field.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../src/components/input-group.tsx";
import { Progress } from "../../src/components/progress.tsx";
import { toast } from "../../src/components/sonner.tsx";
import { CheckIcon } from "../../src/icons/index.ts";

const passwordRequirements = [
  {
    id: "length",
    label: "At least 8 characters",
    test: (val: string) => val.length >= 8,
  },
  {
    id: "lowercase",
    label: "One lowercase letter",
    test: (val: string) => /[a-z]/.test(val),
  },
  {
    id: "uppercase",
    label: "One uppercase letter",
    test: (val: string) => /[A-Z]/.test(val),
  },
  { id: "number", label: "One number", test: (val: string) => /\d/.test(val) },
  {
    id: "special",
    label: "One special character",
    test: (val: string) => /[!@#$%^&*(),.?":{}|<>]/.test(val),
  },
];

const formSchema = z.object({
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .refine((val) => /[a-z]/.test(val), "Password must contain at least one lowercase letter")
    .refine((val) => /[A-Z]/.test(val), "Password must contain at least one uppercase letter")
    .refine((val) => /\d/.test(val), "Password must contain at least one number")
    .refine(
      (val) => /[!@#$%^&*(),.?":{}|<>]/.test(val),
      "Password must contain at least one special character",
    ),
});

export default function FormRhfPassword() {
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      password: "",
    },
  });

  const password = useWatch({
    control: form.control,
    name: "password",
  });

  // Calculate password strength.
  const metRequirements = passwordRequirements.filter((req) => req.test(password || ""));
  const strengthPercentage = (metRequirements.length / passwordRequirements.length) * 100;

  // Determine strength level and color.
  const getStrengthColor = () => {
    if (strengthPercentage === 0) return "bg-neutral-200";
    if (strengthPercentage <= 40) return "bg-red-500";
    if (strengthPercentage <= 80) return "bg-yellow-500";
    return "bg-green-500";
  };

  const allRequirementsMet = metRequirements.length === passwordRequirements.length;

  function onSubmit(data: z.infer<typeof formSchema>) {
    toast("You submitted the following values:", {
      description: (
        <pre className="mt-2 w-[320px] overflow-x-auto rounded-md bg-code p-4 text-code-foreground">
          <code>{JSON.stringify(data, null, 2)}</code>
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
  }

  return (
    <Card className="w-full sm:max-w-md">
      <CardHeader className="border-b">
        <CardTitle>Create Password</CardTitle>
        <CardDescription>Choose a strong password to secure your account.</CardDescription>
      </CardHeader>
      <CardContent>
        <form id="form-rhf-password" onSubmit={form.handleSubmit(onSubmit)}>
          <FieldGroup>
            <Controller
              name="password"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="form-rhf-password-input">Password</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      {...field}
                      id="form-rhf-password-input"
                      type="password"
                      placeholder="Enter your password"
                      aria-invalid={fieldState.invalid}
                      autoComplete="new-password"
                    />
                    <InputGroupAddon align="inline-end">
                      <CheckIcon
                        className={allRequirementsMet ? "text-green-500" : "text-muted-foreground"}
                      />
                    </InputGroupAddon>
                  </InputGroup>

                  {/* Password strength meter. */}
                  <div className="space-y-2">
                    <Progress value={strengthPercentage} className={getStrengthColor()} />

                    {/* Requirements list. */}
                    <div className="space-y-1.5">
                      {passwordRequirements.map((requirement) => {
                        const isMet = requirement.test(password || "");
                        return (
                          <div key={requirement.id} className="flex items-center gap-2 text-sm">
                            <CheckIcon
                              className={
                                isMet ? "size-4 text-green-500" : "size-4 text-muted-foreground"
                              }
                            />
                            <span className={isMet ? "text-foreground" : "text-muted-foreground"}>
                              {requirement.label}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter className="border-t">
        <Field>
          <Button type="submit" form="form-rhf-password">
            Create Password
          </Button>
          <Button type="button" variant="outline" onClick={() => form.reset()}>
            Reset
          </Button>
        </Field>
      </CardFooter>
    </Card>
  );
}
