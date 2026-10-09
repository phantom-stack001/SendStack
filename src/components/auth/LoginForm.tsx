import { useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type LoginFormProps = React.ComponentProps<"div">;

export function LoginForm({ className, ...props }: LoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  function validateEmail(value: string) {
    if (!value.trim()) {
      return "Email is required.";
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return "Enter a valid email address.";
    }
    return null;
  }

  function validatePassword(value: string) {
    if (!value) {
      return "Password is required.";
    }
    if (value.length < 8) {
      return "Password must be at least 8 characters.";
    }
    return null;
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInfoMessage(null);

    const nextEmailError = validateEmail(email);
    const nextPasswordError = validatePassword(password);
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);

    if (nextEmailError || nextPasswordError) {
      return;
    }

    setInfoMessage(
      "Authentication is not connected yet. Sign-in will be enabled when the backend is implemented in a future phase.",
    );
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card className="overflow-hidden p-0">
        <CardContent className="grid p-0 md:grid-cols-2">
          <form className="p-6 md:p-8" onSubmit={handleSubmit} noValidate>
            <FieldGroup>
              <div className="flex flex-col items-center gap-2 text-center">
                <p className="text-xs font-semibold tracking-[0.12em] text-primary uppercase">
                  CTN Slovakia
                </p>
                <h1 className="text-2xl font-bold">Sign in to SendStack</h1>
                <p className="text-balance text-muted-foreground">
                  Access the email compose and queue workspace.
                </p>
              </div>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@organization.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  aria-invalid={emailError ? true : undefined}
                  aria-describedby={emailError ? "email-error" : undefined}
                />
                {emailError ? (
                  <FieldDescription id="email-error" className="text-destructive">
                    {emailError}
                  </FieldDescription>
                ) : null}
              </Field>
              <Field>
                <div className="flex items-center">
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <button
                    type="button"
                    className="ml-auto text-sm text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() =>
                      setInfoMessage(
                        "Password reset will be available when authentication is implemented.",
                      )
                    }
                  >
                    Forgot your password?
                  </button>
                </div>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={passwordError ? true : undefined}
                  aria-describedby={passwordError ? "password-error" : undefined}
                />
                {passwordError ? (
                  <FieldDescription id="password-error" className="text-destructive">
                    {passwordError}
                  </FieldDescription>
                ) : null}
              </Field>
              {infoMessage ? (
                <div
                  role="status"
                  className="rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-muted-foreground"
                >
                  {infoMessage}
                </div>
              ) : null}
              <Field>
                <Button type="submit" className="w-full">Sign in</Button>
              </Field>
              <FieldDescription className="text-center text-sm">
                <Link to="/app/" className="underline-offset-2 hover:underline">
                  Open dashboard UI (unprotected prototype)
                </Link>
              </FieldDescription>
            </FieldGroup>
          </form>
          <div className="relative hidden bg-muted md:block">
            <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-br from-primary/90 via-primary/70 to-[#141821] p-8 text-primary-foreground">
              <p className="text-sm font-semibold tracking-wide uppercase opacity-80">
                SendStack
              </p>
              <p className="mt-2 text-2xl font-semibold leading-tight">
                Compose, queue, and send with accountability.
              </p>
              <p className="mt-3 max-w-sm text-sm text-primary-foreground/85">
                Bulk email operations for CTN Slovakia — delivery through SpaceMail SMTP will be
                handled server-side in a later phase.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
      <FieldDescription className="px-6 text-center">
        By continuing, you agree to our{" "}
        <Link to="/terms/" className="underline-offset-2 hover:underline">Terms of Service</Link>{" "}
        and{" "}
        <Link to="/privacy/" className="underline-offset-2 hover:underline">Privacy Policy</Link>.
      </FieldDescription>
    </div>
  );
}
