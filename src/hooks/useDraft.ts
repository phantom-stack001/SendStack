import { useCallback, useEffect, useState } from "react";

import {
  createDraft,
  DraftApiError,
  getDraft,
  updateDraft,
  type Draft,
  type DraftInput,
} from "@/lib/drafts-api";

type DraftLoadState = {
  draft: Draft | null;
  loading: boolean;
  notFound: boolean;
  loadError: string | null;
};

const idleLoadState: DraftLoadState = {
  draft: null,
  loading: false,
  notFound: false,
  loadError: null,
};

export function useDraft(draftId?: string) {
  const [state, setState] = useState<DraftLoadState>(() =>
    draftId
      ? { draft: null, loading: true, notFound: false, loadError: null }
      : idleLoadState,
  );

  useEffect(() => {
    if (!draftId) {
      return;
    }

    let cancelled = false;

    getDraft(draftId)
      .then((response) => {
        if (cancelled) return;
        setState({
          draft: response.draft,
          loading: false,
          notFound: false,
          loadError: null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof DraftApiError && error.status === 404) {
          setState({
            draft: null,
            loading: false,
            notFound: true,
            loadError: null,
          });
          return;
        }
        setState({
          draft: null,
          loading: false,
          notFound: false,
          loadError:
            error instanceof DraftApiError ? error.message : "Failed to load draft",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [draftId]);

  const saveDraft = useCallback(async (input: DraftInput, existingId?: string | null) => {
    if (existingId) {
      const response = await updateDraft(existingId, input);
      setState((current) => ({ ...current, draft: response.draft }));
      return response.draft;
    }
    const response = await createDraft(input);
    setState((current) => ({ ...current, draft: response.draft }));
    return response.draft;
  }, []);

  return {
    ...state,
    saveDraft,
  };
}
