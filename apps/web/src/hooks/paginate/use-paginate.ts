import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { createBatches } from "@/utils/batch";

type UsePaginateOptions = {
  id?: string;
  initialPage?: number;
  initialPageSize?: number;
};

const usePaginate = <T>(data: T[], opts?: UsePaginateOptions) => {
  const { id, initialPage = 1, initialPageSize = 10 } = opts ?? {};

  const queryClient = useQueryClient();

  const shouldCache = !!id;

  /**
   * Shared pagination state
   */
  const stateQuery = useQuery({
    queryKey: ["pagination-state", id],
    enabled: shouldCache,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: () => ({
      page: initialPage,
      pageSize: initialPageSize,
    }),
  });

  const page = shouldCache
    ? (stateQuery.data?.page ?? initialPage)
    : initialPage;

  const pageSize = shouldCache
    ? (stateQuery.data?.pageSize ?? initialPageSize)
    : initialPageSize;

  /**
   * Cached batches
   */
  const paginatedQuery = useQuery({
    queryKey: ["pagination-data", id, pageSize, data],
    enabled: shouldCache,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: () => createBatches(data, pageSize),
  });

  const nonCachedPaginated = useMemo(() => {
    if (shouldCache) return [];
    return createBatches(data, pageSize);
  }, [data, pageSize, shouldCache]);

  const paginated = shouldCache
    ? (paginatedQuery.data ?? [])
    : nonCachedPaginated;

  const totalItems = data.length;
  const totalPages = paginated.length;

  const pageData = paginated[page - 1] ?? [];

  const showingFrom = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;

  const showingTill = Math.min(page * pageSize, totalItems);

  const disableNext = page >= totalPages;
  const disablePrev = page <= 1;

  const updateState = useCallback(
    (
      updater:
        | { page?: number; pageSize?: number }
        | ((prev: { page: number; pageSize: number }) => {
            page?: number;
            pageSize?: number;
          }),
    ) => {
      if (!shouldCache) return;

      queryClient.setQueryData(
        ["pagination-state", id],
        (prev?: { page: number; pageSize: number }) => {
          const current = prev ?? {
            page: initialPage,
            pageSize: initialPageSize,
          };

          const updates =
            typeof updater === "function" ? updater(current) : updater;

          return {
            ...current,
            ...updates,
          };
        },
      );
    },
    [id, initialPage, initialPageSize, queryClient, shouldCache],
  );

  const setPage = useCallback(
    (page: number) => {
      updateState({ page });
    },
    [updateState],
  );

  const setPageSize = (pageSize: number) => {
    updateState({
      pageSize,
      page: 1,
    });
  };

  const next = () => {
    if (disableNext) return;

    updateState((prev) => ({
      page: prev.page + 1,
    }));
  };

  const prev = () => {
    if (disablePrev) return;

    updateState((prev) => ({
      page: prev.page - 1,
    }));
  };

  useEffect(() => {
    setPage(1);
  }, [data, setPage]);

  return {
    pageData,
    paginated,

    page,
    pageSize,

    setPage,
    setPageSize,

    next,
    prev,

    disableNext,
    disablePrev,

    totalItems,
    totalPages,

    showingFrom,
    showingTill,
  };
};

export default usePaginate;
