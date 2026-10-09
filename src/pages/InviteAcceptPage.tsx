import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function InviteAcceptPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setError(null);
    const response = await fetch("/api/invitations/accept", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "This invitation could not be accepted.");
      return;
    }
    setMessage("Invitation accepted. Your role is now active.");
  }

  return (
    <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>Accept invitation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Sign in with the invited email address, verify that email, then accept.</p>
          {error ? <p className="text-destructive">{error}</p> : null}
          {message ? <p>{message}</p> : null}
          <Button type="button" onClick={() => void accept()} disabled={token.length < 20}>Accept invitation</Button>
          <Button variant="outline" asChild><Link to="/login/">Sign in</Link></Button>
        </CardContent>
      </Card>
    </main>
  );
}
