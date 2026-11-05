"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";
import { Button } from "@/components/ui/button";

export function PublicationPanel({ deploymentId }: { deploymentId: number }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const options = trpc.deployment.publication.queryOptions({ deploymentId });
  const { data, isError } = useQuery({ ...options, refetchInterval: 2500 });
  const retry = useMutation({
    ...trpc.deployment.retryPublication.mutationOptions(),
    onSuccess: () => client.invalidateQueries({ queryKey: options.queryKey }),
  });
  const publication = data?.publication;
  const labels = {
    pending: "Pending publication",
    publishing: "Publishing",
    published: "Published",
    failed: "Publication failed",
  };
  return (
    <section
      className="glass-panel p-5"
      aria-label={`Image publication for deployment ${deploymentId}`}
    >
      <h2 className="font-semibold">Image publication</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Deployment #{deploymentId} ·{" "}
        {publication
          ? labels[publication.status]
          : isError
            ? "Status unavailable"
            : data
              ? "No publication recorded"
              : "Loading status"}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Publication is separate from container start. Application readiness has
        not been checked.
      </p>
      {publication?.lastError && (
        <p role="status" className="mt-3 break-words text-sm text-destructive">
          {publication.lastError}
        </p>
      )}
      {publication &&
        publication.status !== "published" &&
        data?.status === "success" && (
          <Button
            className="mt-4"
            variant="outline"
            disabled={retry.isPending}
            onClick={() => retry.mutate({ deploymentId })}
          >
            {retry.isPending ? "Queueing publication…" : "Retry publication"}
          </Button>
        )}
      {retry.isSuccess && (
        <p role="status" className="mt-2 text-sm">
          {retry.data.queued
            ? "Publication recovery queued. The status will update when it finishes."
            : "This image is already published."}
        </p>
      )}
      {retry.isError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {retry.error.message}
        </p>
      )}
    </section>
  );
}
