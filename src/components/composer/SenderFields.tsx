import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type SenderFieldsProps = {
  senderName: string;
  senderEmail: string;
  onSenderNameChange: (value: string) => void;
  onSenderEmailChange: (value: string) => void;
  senderEmailError?: string | null;
};

export function SenderFields({
  senderName,
  senderEmail,
  onSenderNameChange,
  onSenderEmailChange,
  senderEmailError,
}: SenderFieldsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="sender-name">Sender name</Label>
        <Input
          id="sender-name"
          value={senderName}
          onChange={(event) => onSenderNameChange(event.target.value)}
          placeholder="Your name or organization"
          maxLength={200}
          autoComplete="name"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="sender-email">Sender email</Label>
        <Input
          id="sender-email"
          type="email"
          value={senderEmail}
          onChange={(event) => onSenderEmailChange(event.target.value)}
          placeholder="name@example.com"
          maxLength={320}
          autoComplete="email"
          aria-invalid={Boolean(senderEmailError)}
        />
        {senderEmailError ? (
          <p className="text-xs text-destructive" role="alert">{senderEmailError}</p>
        ) : (
          <p className="text-xs text-muted-foreground" role="note">
            Draft metadata only — sending identity is not verified in this phase.
          </p>
        )}
      </div>
    </div>
  );
}
