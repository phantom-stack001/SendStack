import { Monitor, Smartphone } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EMAIL_BODY_PREVIEW_CSS } from "@/lib/email-body-styles";
import { cn } from "@/lib/utils";

type EmailPreviewProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  senderName: string;
  senderEmail: string;
  subject: string;
  bodyHtml: string;
};

export function EmailPreview({
  open,
  onOpenChange,
  senderName,
  senderEmail,
  subject,
  bodyHtml,
}: EmailPreviewProps) {
  const [mode, setMode] = useState<"desktop" | "mobile">("desktop");

  const srcDoc = useMemo(() => {
    const safeBody = bodyHtml || "<p></p>";
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${EMAIL_BODY_PREVIEW_CSS}</style></head><body>${safeBody}</body></html>`;
  }, [bodyHtml]);

  const fromLine =
    [senderName.trim(), senderEmail.trim()].filter(Boolean).join(" · ") ||
    "Sender not set";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Email preview</DialogTitle>
          <DialogDescription>
            Preview only — this is not a sent message and may differ slightly in email clients.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={mode === "desktop" ? "secondary" : "outline"}
            onClick={() => setMode("desktop")}
          >
            <Monitor className="size-4" />
            Desktop
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "mobile" ? "secondary" : "outline"}
            onClick={() => setMode("mobile")}
          >
            <Smartphone className="size-4" />
            Mobile
          </Button>
        </div>

        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-4 text-sm">
          <p className="wrap-break-word"><span className="text-muted-foreground">From:</span> {fromLine}</p>
          <p className="wrap-break-word">
            <span className="text-muted-foreground">Subject:</span>{" "}
            {subject.trim() || "(No subject)"}
          </p>
        </div>

        <div className="flex justify-center overflow-x-auto rounded-lg border border-border bg-muted/20 p-3 sm:p-4">
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={srcDoc}
            className={cn(
              "h-[min(50dvh,520px)] w-full max-w-full rounded-md border border-border bg-white shadow-sm",
              mode === "mobile" ? "max-w-[390px]" : "max-w-3xl",
            )}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
