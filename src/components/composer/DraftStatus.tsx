import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type DraftStatusProps = {
  dirty: boolean;
  saving: boolean;
  lastSavedAt: string | null;
  error: string | null;
  success: string | null;
  className?: string;
};

function formatSavedAt(iso: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function DraftStatus({
  dirty,
  saving,
  lastSavedAt,
  error,
  success,
  className,
}: DraftStatusProps) {
  return (
    <div className={cn("flex flex-col gap-1 text-sm", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {saving ? (
          <Badge variant="secondary">Saving…</Badge>
        ) : dirty ? (
          <Badge variant="outline">Unsaved changes</Badge>
        ) : lastSavedAt ? (
          <Badge variant="secondary">Saved</Badge>
        ) : (
          <Badge variant="outline">New draft</Badge>
        )}
        {lastSavedAt && !dirty && !saving ? (
          <span className="text-xs text-muted-foreground">
            Last saved {formatSavedAt(lastSavedAt)}
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">{error}</p>
      ) : null}
      {success ? (
        <p className="text-xs text-primary" role="status">{success}</p>
      ) : null}
    </div>
  );
}
