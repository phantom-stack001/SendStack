import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EMAIL_BODY_PREVIEW_CSS } from "@/lib/email-body-styles";

type SendReviewDialogProps = {
  open: boolean;
  sending: boolean;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string;
  onCancel: () => void;
  onConfirm: () => void;
};

function Line({ label, value }: { label: string; value: string }) {
  return (
    <p className="wrap-break-word">
      <span className="text-muted-foreground">{label}: </span>
      {value}
    </p>
  );
}

export function SendReviewDialog({
  open,
  sending,
  from,
  to,
  cc,
  bcc,
  subject,
  bodyHtml,
  onCancel,
  onConfirm,
}: SendReviewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !sending) onCancel(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review before sending</DialogTitle>
          <DialogDescription>
            Confirming submits this message through the outgoing mail server. Nothing is sent while you are only reviewing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <Line label="From" value={from} />
          <Line label="To" value={to.join(", ") || "None"} />
          {cc.length > 0 ? <Line label="Cc" value={cc.join(", ")} /> : null}
          <Line label="Bcc" value={bcc.length > 0 ? `${bcc.length} recipient${bcc.length === 1 ? "" : "s"}: ${bcc.join(", ")}` : "None"} />
          <Line label="Subject" value={subject || "(No subject)"} />
        </div>
        <iframe
          title="Message preview"
          sandbox=""
          className="h-64 w-full rounded-md border border-border bg-white"
          srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${EMAIL_BODY_PREVIEW_CSS}</style></head><body>${bodyHtml || "<p></p>"}</body></html>`}
        />
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={sending}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm} disabled={sending}>
            {sending ? "Sending…" : "Send email"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
