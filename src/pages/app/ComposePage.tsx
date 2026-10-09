import { lazy, Suspense, useCallback } from "react";
import { useParams } from "react-router-dom";

import {
  buildFormStateFromDraft,
  emptyComposerFormState,
} from "@/lib/composer-form";
import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDraft } from "@/hooks/useDraft";

const EmailComposer = lazy(async () => {
  const module = await import("@/components/composer/EmailComposer");
  return { default: module.EmailComposer };
});

function ComposePageContent({ draftId }: { draftId?: string }) {
  const { draft, loading, notFound, loadError, saveDraft } = useDraft(draftId);
  const handleSave = useCallback(
    (input: Parameters<typeof saveDraft>[0], existingId?: string | null) =>
      saveDraft(input, existingId),
    [saveDraft],
  );

  const composerKey = draft?.id ?? draftId ?? "new";
  const initialForm = draft ? buildFormStateFromDraft(draft) : emptyComposerFormState;
  const initialSavedAt = draft?.updatedAt ?? null;

  return (
    <>
      <PageMeta
        title="Compose | SendStack"
        description="Create, edit, and save email drafts."
        canonicalPath={draftId ? `/app/compose/${draftId}/` : "/app/compose/"}
      />
      <AppPageContainer>
        <PageHeader
          title="Compose email"
          description="Create, edit, and save email drafts."
          notice="Drafts are saved to your account. Campaign queues stay simulation-only. Individual test delivery is limited to Settings."
        />

        {loading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-full max-w-xl" />
            <Skeleton className="h-80 w-full" />
          </div>
        ) : notFound ? (
          <Card>
            <CardHeader>
              <CardTitle>Draft not found</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              This draft may have been deleted or you do not have access to it.
            </CardContent>
          </Card>
        ) : loadError ? (
          <Card>
            <CardHeader>
              <CardTitle>Could not load draft</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-destructive">{loadError}</CardContent>
          </Card>
        ) : (
          <Suspense
            fallback={
              <div className="space-y-4">
                <Skeleton className="h-10 w-full max-w-xl" />
                <Skeleton className="h-80 w-full" />
              </div>
            }
          >
            <EmailComposer
              key={composerKey}
              draftId={draftId}
              initialForm={initialForm}
              initialSavedAt={initialSavedAt}
              onSave={handleSave}
            />
          </Suspense>
        )}
      </AppPageContainer>
    </>
  );
}

export function ComposePage() {
  const { draftId } = useParams<{ draftId?: string }>();
  return <ComposePageContent key={draftId ?? "new"} draftId={draftId} />;
}
