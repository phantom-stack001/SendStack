import { useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { AuthCardShell } from "@/components/auth/AuthCardShell";
import { Button } from "@/components/ui/button";
import { PageMeta } from "@/components/layout/PageMeta";
import { authClient } from "@/lib/auth-client";

export function VerifyEmailPage() {
  const location = useLocation();
  const emailFromState =
    location.state && typeof location.state === "object" && "email" in location.state
      ? String((location.state as { email?: string }).email ?? "")
      : "";
  const [status, setStatus] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  async function resendVerification() {
    if (!emailFromState) {
      setStatus("Sign in with your email to request another verification message.");
      return;
    }
    setIsSending(true);
    await authClient.sendVerificationEmail({
      email: emailFromState,
      callbackURL: "/app/",
    });
    setIsSending(false);
    setStatus(
      "If delivery is configured, a new verification email was requested. In local development, check the API server logs for the verification link.",
    );
  }

  return (
    <>
      <PageMeta
        title="Verify email | SendStack"
        description="Verify your SendStack account email address."
        canonicalPath="/verify-email/"
      />
      <AuthCardShell>
        <div className="space-y-4 text-center">
          <h1 className="text-2xl font-bold">Verify your email</h1>
          <p className="text-sm text-muted-foreground">
            We need to confirm your email address before you can access the SendStack dashboard.
            {emailFromState ? ` Check the inbox for ${emailFromState}.` : null}
          </p>
          <p className="text-xs text-muted-foreground">
            Verification links are only sent when server-side email delivery is configured. Local
            development logs links in the API server output when{" "}
            <code className="rounded bg-muted px-1">AUTH_EMAIL_DELIVERY=console</code>.
          </p>
          {status ? (
            <p role="status" className="text-sm text-muted-foreground">{status}</p>
          ) : null}
          <div className="flex flex-col gap-2">
            <Button type="button" variant="outline" onClick={resendVerification} disabled={isSending}>
              {isSending ? "Sending…" : "Resend verification email"}
            </Button>
            <Button asChild variant="ghost">
              <Link to="/login/">Back to sign in</Link>
            </Button>
          </div>
        </div>
      </AuthCardShell>
    </>
  );
}
