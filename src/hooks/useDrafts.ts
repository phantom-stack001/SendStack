import { useCallback, useEffect, useState } from "react";

import {
  deleteDraft,
  DraftApiError,
  listDrafts,
  type Draft,
} from "@/lib/drafts-api";

export function useDrafts(page = 1, limit = 25) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState({
    page: 1,
    limit,
    total: 0,
    totalPages: 1,
  });

  useEffect(() => {
    let cancelled = false;

    listDrafts(page, limit)
      .then((response) => {
        if (cancelled) return;
        setDrafts(response.drafts);
        setPagination(response.pagination);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof DraftApiError ? err.message : "Failed to load drafts");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [page, limit]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await listDrafts(page, limit);
      setDrafts(response.drafts);
      setPagination(response.pagination);
      setError(null);
    } catch (err) {
      setError(err instanceof DraftApiError ? err.message : "Failed to load drafts");
    } finally {
      setLoading(false);
    }
  }, [page, limit]);

  const removeDraft = useCallback(
    async (id: string) => {
      await deleteDraft(id);
      await refresh();
    },
    [refresh],
  );

  return {
    drafts,
    loading,
    error,
    pagination,
    refresh,
    removeDraft,
  };
}
