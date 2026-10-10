import { Eye, Save, Send } from "lucide-react";

import { DraftStatus } from "@/components/composer/DraftStatus";
import { Button } from "@/components/ui/button";

type ComposerHeaderProps = {
  dirty: boolean;
  saving: boolean;
  lastSavedAt: string | null;
  error: string | null;
  success: string | null;
  onSave: () => void;
  onPreview: () => void;
  onDiscard: () => void;
  canDiscard: boolean;
  canSend?: boolean;
  sending?: boolean;
  onSend?: () => void;
};

export function ComposerHeader({
  dirty,
  saving,
  lastSavedAt,
  error,
  success,
  onSave,
  onPreview,
  onDiscard,
  canDiscard,
  canSend,
  sending,
  onSend,
}: ComposerHeaderProps) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <DraftStatus
        dirty={dirty}
        saving={saving}
        lastSavedAt={lastSavedAt}
        error={error}
        success={success}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onPreview}>
          <Eye />
          Preview email
        </Button>
        {canDiscard ? (
          <Button type="button" variant="ghost" onClick={onDiscard} disabled={saving}>
            Discard changes
          </Button>
        ) : null}
        <Button type="button" onClick={onSave} disabled={saving || sending}>
          <Save />
          {saving ? "Saving…" : "Save draft"}
        </Button>
        {canSend && onSend ? (
          <Button type="button" onClick={onSend} disabled={saving || sending}>
            <Send />
            {sending ? "Sending…" : "Send"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
