"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import toast from "@/components/toast/toast";

export function ProjectRetirementPanel() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const retired = useQuery(trpc.project.retired.queryOptions());
  const retry = useMutation({
    ...trpc.project.deleteProject.mutationOptions(),
    onSuccess: (result) => {
      client.setQueryData(trpc.project.retired.queryKey(), (projects) =>
        projects?.map((project) =>
          project.id === result.id ? result : project,
        ),
      );
      void client.invalidateQueries({ queryKey: trpc.project.list.queryKey() });
    },
    onError: () =>
      toast({
        title: "Could not retry cleanup",
        description: "Check the project outcome and retry.",
        variant: "error",
      }),
  });
  if (!retired.isError && !retired.data?.length) return null;
  return (
    <section className="space-y-4" aria-label="Retired projects">
      <h2 className="text-xl font-semibold">Retired projects</h2>
      <p className="text-sm text-muted-foreground">
        Retired apps cannot deploy or stream logs. Cleanup can be retried
        without restoring them.
      </p>
      {retired.isError && (
        <p role="alert">
          Could not load retirement outcomes.{" "}
          <Button variant="outline" onClick={() => void retired.refetch()}>
            Reload outcomes
          </Button>
        </p>
      )}
      {retired.data?.map((project) => (
        <article key={project.id} className="glass-panel space-y-3 p-5">
          <h3 className="font-medium">{project.name}</h3>
          <p role="status">{project.retirement?.message}</p>
          <ul className="space-y-2 text-sm">
            {project.apps.map((app) => (
              <li key={app.id}>
                <span className="font-medium">{app.appName}: </span>
                {app.retirement?.message ??
                  "Runtime cleanup pending. Retry cleanup to recover."}
              </li>
            ))}
          </ul>
          {project.retirement?.status !== "complete" && (
            <Button
              disabled={retry.isPending}
              onClick={() => retry.mutate({ projectId: project.id })}
            >
              {retry.isPending && retry.variables?.projectId === project.id
                ? "Retrying cleanup…"
                : "Retry cleanup"}
            </Button>
          )}
        </article>
      ))}
    </section>
  );
}
