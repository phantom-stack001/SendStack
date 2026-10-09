import { FileText, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { DeleteDraftDialog } from "@/components/composer/DeleteDraftDialog";
import { DraftsTable } from "@/components/drafts/DraftsTable";
import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageHeader } from "@/components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDrafts } from "@/hooks/useDrafts";
import { DraftApiError, type Draft } from "@/lib/drafts-api";

export function DraftsPage() {
  const { drafts, loading, error, removeDraft } = useDrafts();
  const [pendingDelete, setPendingDelete] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await removeDraft(pendingDelete.id);
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(
        err instanceof DraftApiError ? err.message : "Could not delete draft",
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <PageMeta
        title="Drafts | SendStack"
        description="Manage your saved email drafts."
        canonicalPath="/app/drafts/"
      />
      <AppPageContainer>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <PageHeader
            title="Drafts"
            description="Manage your saved email drafts."
          />
          <Button asChild>
            <Link to="/app/compose/">
              <Plus />
              New draft
            </Link>
          </Button>
        </div>

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : error ? (
          <Card>
            <CardContent className="py-6 text-sm text-destructive">{error}</CardContent>
          </Card>
        ) : drafts.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No drafts yet"
            description="Create a new email draft to start composing rich-text messages."
            action={
              <Button asChild>
                <Link to="/app/compose/">Compose email</Link>
              </Button>
            }
          />
        ) : (
          <Card>
            <CardContent className="p-0 sm:p-0">
              <DraftsTable drafts={drafts} onDelete={setPendingDelete} />
            </CardContent>
          </Card>
        )}

        {deleteError ? (
          <p className="text-sm text-destructive" role="alert">{deleteError}</p>
        ) : null}
      </AppPageContainer>

      <DeleteDraftDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => void confirmDelete()}
        loading={deleting}
      />
    </>
  );
}
