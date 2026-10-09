import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { AuthCardShell } from "@/components/auth/AuthCardShell";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import {
  mapAuthErrorMessage,
  validateConfirmPassword,
  validateEmail,
  validateName,
  validatePassword,
} from "@/lib/auth-validation";

export function RegisterForm() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const errors = {
      name: validateName(name),
      email: validateEmail(email),
      password: validatePassword(password),
      confirmPassword: validateConfirmPassword(password, confirmPassword),
    };
    setFieldErrors(errors);
    if (Object.values(errors).some(Boolean)) {
      return;
    }

    setIsSubmitting(true);
    const { error } = await authClient.signUp.email({
      name: name.trim(),
      email: email.trim(),
      password,
      callbackURL: "/app/",
    });
    setIsSubmitting(false);

    if (error) {
      setFormError(mapAuthErrorMessage(error.message ?? "Registration failed."));
      return;
    }

    navigate("/verify-email/", {
      replace: true,
      state: { email: email.trim(), fromRegistration: true },
    });
  }

  return (
    <AuthCardShell>
      <form onSubmit={handleSubmit} noValidate>
        <FieldGroup>
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="text-xs font-semibold tracking-[0.12em] text-primary uppercase">
              CTN Slovakia
            </p>
            <h1 className="text-2xl font-bold">Create your SendStack account</h1>
            <p className="text-balance text-muted-foreground">
              Register to access the CTN Slovakia email workspace.
            </p>
          </div>
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={isSubmitting}
              aria-invalid={fieldErrors.name ? true : undefined}
            />
            {fieldErrors.name ? (
              <FieldDescription className="text-destructive">{fieldErrors.name}</FieldDescription>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={isSubmitting}
              aria-invalid={fieldErrors.email ? true : undefined}
            />
            {fieldErrors.email ? (
              <FieldDescription className="text-destructive">{fieldErrors.email}</FieldDescription>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isSubmitting}
              aria-invalid={fieldErrors.password ? true : undefined}
            />
            {fieldErrors.password ? (
              <FieldDescription className="text-destructive">{fieldErrors.password}</FieldDescription>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="confirm-password">Confirm password</FieldLabel>
            <Input
              id="confirm-password"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={isSubmitting}
              aria-invalid={fieldErrors.confirmPassword ? true : undefined}
            />
            {fieldErrors.confirmPassword ? (
              <FieldDescription className="text-destructive">
                {fieldErrors.confirmPassword}
              </FieldDescription>
            ) : null}
          </Field>
          {formError ? (
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {formError}
            </div>
          ) : null}
          <Field>
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "Creating account…" : "Create account"}
            </Button>
          </Field>
          <FieldDescription className="text-center text-sm">
            Already have an account?{" "}
            <Link to="/login/" className="underline-offset-2 hover:underline">Sign in</Link>
          </FieldDescription>
        </FieldGroup>
      </form>
    </AuthCardShell>
  );
}
