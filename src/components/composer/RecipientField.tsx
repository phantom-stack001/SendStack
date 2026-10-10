import { X } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { addRecipients } from "@/lib/recipient-input";

type RecipientFieldProps = {
  id: string;
  label: string;
  required?: boolean;
  values: string[];
  disabled?: boolean;
  onChange: (values: string[]) => void;
  onInvalid: (message: string | null) => void;
};

export function RecipientField({
  id,
  label,
  required,
  values,
  disabled,
  onChange,
  onInvalid,
}: RecipientFieldProps) {
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const { next, invalid } = addRecipients(values, raw);
    onChange(next);
    setDraft("");
    onInvalid(invalid.length > 0 ? `${invalid[0]} is not a valid email address.` : null);
  };

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-input bg-transparent p-2">
        {values.map((email) => (
          <Badge key={email} variant="secondary" className="max-w-full">
            <span className="truncate">{email}</span>
            <button
              type="button"
              className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Remove ${email}`}
              disabled={disabled}
              onClick={() => onChange(values.filter((value) => value !== email))}
            >
              <X />
            </button>
          </Badge>
        ))}
        <Input
          id={id}
          value={draft}
          disabled={disabled}
          placeholder={values.length === 0 ? "name@example.com" : "Add another"}
          className="h-8 min-w-[10rem] flex-1 border-0 shadow-none focus-visible:ring-0"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft.trim()) commit(draft);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "," || event.key === ";") {
              event.preventDefault();
              if (draft.trim()) commit(draft);
            }
            if (event.key === "Backspace" && !draft && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (!/[,;\n]/.test(text)) return;
            event.preventDefault();
            commit(text);
          }}
        />
      </div>
    </div>
  );
}
