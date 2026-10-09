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
import {
  MARKETING_STATUS_OPTIONS,
  marketingStatus,
  type MarketingStatus,
} from "@/lib/contact-status";
import type { Contact, ContactInput } from "@/lib/recipients-api";

type ContactDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact | null;
  onSave: (input: ContactInput) => Promise<void>;
};

function AddContactForm({
  onSave,
  onClose,
}: {
  onSave: (input: ContactInput) => Promise<void>;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Email is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ email: trimmed });
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
        <DialogTitle>Add contact</DialogTitle>
        <DialogDescription>
          Contacts are added as subscribed and eligible for campaigns until you unsubscribe them.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="contact-email">Email</Label>
        <Input
          id="contact-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.com"
          required
        />
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">{error}</p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="button" onClick={() => void handleSubmit()} disabled={saving}>
          {saving ? "Adding…" : "Add contact"}
        </Button>
      </DialogFooter>
    </>
  );
}

function EditContactForm({
  contact,
  onSave,
  onClose,
}: {
  contact: Contact;
  onSave: (input: ContactInput) => Promise<void>;
  onClose: () => void;
}) {
  const [email, setEmail] = useState(contact.email);
  const [firstName, setFirstName] = useState(contact.firstName);
  const [lastName, setLastName] = useState(contact.lastName);
  const [company, setCompany] = useState(contact.company);
  const [phone, setPhone] = useState(contact.phone);
  const [subscriptionStatus, setSubscriptionStatus] = useState<MarketingStatus>(
    marketingStatus(contact.subscriptionStatus),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
        <DialogTitle>Edit contact</DialogTitle>
        <DialogDescription>Update contact details and subscription status.</DialogDescription>
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
          <Label htmlFor="contact-status">Status</Label>
          <select
            id="contact-status"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
            value={subscriptionStatus}
            onChange={(e) => setSubscriptionStatus(e.target.value as MarketingStatus)}
          >
            {MARKETING_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
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
  const isEdit = Boolean(contact);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={isEdit ? "max-h-[90vh] overflow-y-auto sm:max-w-lg" : "sm:max-w-md"}>
        {open && !contact ? (
          <AddContactForm key="new" onSave={onSave} onClose={() => onOpenChange(false)} />
        ) : null}
        {open && contact ? (
          <EditContactForm
            key={contact.id}
            contact={contact}
            onSave={onSave}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
