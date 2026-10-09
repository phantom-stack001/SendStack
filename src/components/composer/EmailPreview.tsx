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
import { cn } from "@/lib/utils";

type EmailPreviewProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  senderName: string;
  senderEmail: string;
  subject: string;
  bodyHtml: string;
};

const PREVIEW_STYLES = `
  body {
    margin: 0;
    padding: 16px;
    font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    font-size: 15px;
    line-height: 1.6;
    color: #141821;
    background: #ffffff;
  }
  a { color: #0f7a72; text-decoration: underline; }
  h1, h2, h3 { line-height: 1.25; margin: 1rem 0 0.5rem; }
  p { margin: 0 0 0.75rem; }
  ul, ol { margin: 0 0 0.75rem 1.25rem; padding: 0; }
  blockquote {
    margin: 0 0 0.75rem;
    padding-left: 0.75rem;
    border-left: 3px solid #dcecea;
    color: #5b6578;
  }
`;

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
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${PREVIEW_STYLES}</style></head><body>${safeBody}</body></html>`;
  }, [bodyHtml]);

  const fromLine =
    [senderName.trim(), senderEmail.trim()].filter(Boolean).join(" · ") ||
    "Sender not set";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-4">
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
          <p><span className="text-muted-foreground">From:</span> {fromLine}</p>
          <p>
            <span className="text-muted-foreground">Subject:</span>{" "}
            {subject.trim() || "(No subject)"}
          </p>
        </div>

        <div className="flex justify-center rounded-lg border border-border bg-muted/20 p-4">
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={srcDoc}
            className={cn(
              "h-[min(60vh,520px)] w-full rounded-md border border-border bg-white shadow-sm",
              mode === "mobile" ? "max-w-[390px]" : "max-w-3xl",
            )}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
