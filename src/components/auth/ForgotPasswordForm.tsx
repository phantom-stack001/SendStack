import { useState } from "react";
import { Link } from "react-router-dom";

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
import { validateEmail } from "@/lib/auth-validation";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatusMessage(null);
    const nextEmailError = validateEmail(email);
    setEmailError(nextEmailError);
    if (nextEmailError) {
      return;
    }

    setIsSubmitting(true);
    const redirectTo = `${window.location.origin}/reset-password/`;
    await authClient.requestPasswordReset({
      email: email.trim(),
      redirectTo,
    });
    setIsSubmitting(false);

    setStatusMessage(
      "If an account exists for that email, we sent password reset instructions when email delivery is configured. In local development, check the API server logs for the reset link.",
    );
  }

  return (
    <AuthCardShell>
      <form onSubmit={handleSubmit} noValidate>
        <FieldGroup>
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="text-xs font-semibold tracking-[0.12em] text-primary uppercase">
              CTN Slovakia
            </p>
            <h1 className="text-2xl font-bold">Reset your password</h1>
            <p className="text-balance text-muted-foreground">
              Enter the email associated with your SendStack account.
            </p>
          </div>
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
              aria-invalid={emailError ? true : undefined}
            />
            {emailError ? (
              <FieldDescription className="text-destructive">{emailError}</FieldDescription>
            ) : null}
          </Field>
          {statusMessage ? (
            <div role="status" className="rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
              {statusMessage}
            </div>
          ) : null}
          <Field>
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "Sending…" : "Send reset link"}
            </Button>
          </Field>
          <FieldDescription className="text-center text-sm">
            <Link to="/login/" className="underline-offset-2 hover:underline">Back to sign in</Link>
          </FieldDescription>
        </FieldGroup>
      </form>
    </AuthCardShell>
  );
}
