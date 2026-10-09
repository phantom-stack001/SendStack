import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Contact, ContactInput, SubscriptionStatus } from "@/lib/recipients-api";

const STATUSES: SubscriptionStatus[] = ["unknown", "pending", "subscribed", "unsubscribed"];

type ContactDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact | null;
  onSave: (input: ContactInput) => Promise<void>;
};

function ContactDialogForm({
  contact,
  onSave,
  onClose,
}: {
  contact?: Contact | null;
  onSave: (input: ContactInput) => Promise<void>;
  onClose: () => void;
}) {
  const [email, setEmail] = useState(contact?.email ?? "");
  const [firstName, setFirstName] = useState(contact?.firstName ?? "");
  const [lastName, setLastName] = useState(contact?.lastName ?? "");
  const [company, setCompany] = useState(contact?.company ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus>(
    contact?.subscriptionStatus ?? "unknown",
  );
  const [consentSource, setConsentSource] = useState("");
  const [consentMethod, setConsentMethod] = useState("");
  const [consentOccurredAt, setConsentOccurredAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const needsConsent = subscriptionStatus === "subscribed";

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      const input: ContactInput = {
        email,
        firstName,
        lastName,
        company,
        phone,
        subscriptionStatus,
      };
      if (needsConsent) {
        input.consentSource = consentSource;
        input.consentMethod = consentMethod;
        input.consentOccurredAt = consentOccurredAt
          ? new Date(consentOccurredAt).toISOString()
          : undefined;
      }
      await onSave(input);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save contact");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
        <DialogHeader>
          <DialogTitle>{contact ? "Edit contact" : "Add contact"}</DialogTitle>
          <DialogDescription>
            Imported contacts default to unknown consent. Subscribed status requires documented consent.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="contact-email">Email</Label>
            <Input id="contact-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="contact-first">First name</Label>
              <Input id="contact-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact-last">Last name</Label>
              <Input id="contact-last" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact-company">Company</Label>
            <Input id="contact-company" value={company} onChange={(e) => setCompany(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact-phone">Phone</Label>
            <Input id="contact-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact-status">Subscription status</Label>
            <select
              id="contact-status"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
              value={subscriptionStatus}
              onChange={(e) => setSubscriptionStatus(e.target.value as SubscriptionStatus)}
            >
              {STATUSES.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </div>
          {needsConsent ? (
            <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Consent evidence (required for subscribed)</p>
              <div className="space-y-1.5">
                <Label htmlFor="consent-source">Consent source</Label>
                <Input id="consent-source" value={consentSource} onChange={(e) => setConsentSource(e.target.value)} placeholder="e.g. Website signup form" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="consent-method">Consent method</Label>
                <Input id="consent-method" value={consentMethod} onChange={(e) => setConsentMethod(e.target.value)} placeholder="e.g. Checkbox opt-in" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="consent-at">Consent date & time</Label>
                <Input id="consent-at" type="datetime-local" value={consentOccurredAt} onChange={(e) => setConsentOccurredAt(e.target.value)} />
              </div>
            </div>
          ) : null}
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={saving}>
            {saving ? "Saving…" : "Save contact"}
          </Button>
        </DialogFooter>
    </>
  );
}

export function ContactDialog({ open, onOpenChange, contact, onSave }: ContactDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {open ? (
          <ContactDialogForm
            key={contact?.id ?? "new"}
            contact={contact}
            onSave={onSave}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
