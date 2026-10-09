import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

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
import { mapAuthErrorMessage, validateConfirmPassword, validatePassword } from "@/lib/auth-validation";

export function ResetPasswordForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const tokenError = searchParams.get("error");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resetToken = searchParams.get("token");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    if (!resetToken) {
      setFormError("This reset link is invalid or has expired.");
      return;
    }

    const errors = {
      password: validatePassword(password),
      confirmPassword: validateConfirmPassword(password, confirmPassword),
    };
    setFieldErrors(errors);
    if (Object.values(errors).some(Boolean)) {
      return;
    }

    setIsSubmitting(true);
    const { error } = await authClient.resetPassword({
      newPassword: password,
      token: resetToken,
    });
    setIsSubmitting(false);

    if (error) {
      setFormError(mapAuthErrorMessage(error.message ?? "Unable to reset password."));
      return;
    }

    navigate("/login/", {
      replace: true,
      state: { message: "Password updated. Sign in with your new password." },
    });
  }

  if (tokenError) {
    return (
      <AuthCardShell>
        <div className="space-y-4 text-center">
          <h1 className="text-2xl font-bold">Reset link expired</h1>
          <p className="text-sm text-muted-foreground">
            Request a new password reset link to continue.
          </p>
          <Button asChild>
            <Link to="/forgot-password/">Request new link</Link>
          </Button>
        </div>
      </AuthCardShell>
    );
  }

  if (!resetToken) {
    return (
      <AuthCardShell>
        <div className="space-y-4 text-center">
          <h1 className="text-2xl font-bold">Invalid reset link</h1>
          <p className="text-sm text-muted-foreground">
            Open the link from your email or request a new reset.
          </p>
          <Button asChild variant="outline">
            <Link to="/forgot-password/">Forgot password</Link>
          </Button>
        </div>
      </AuthCardShell>
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
            <h1 className="text-2xl font-bold">Choose a new password</h1>
            <p className="text-balance text-muted-foreground">
              Use at least 8 characters for your SendStack account.
            </p>
          </div>
          <Field>
            <FieldLabel htmlFor="password">New password</FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isSubmitting}
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
              {isSubmitting ? "Updating…" : "Update password"}
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </AuthCardShell>
  );
}
