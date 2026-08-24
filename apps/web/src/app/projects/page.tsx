"use client";

import {
  ArrowUpRight,
  Loader2,
  MoreVertical,
  PlusCircle,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import Empty from "@/components/states/empty";
import { Button, buttonVariants } from "@/components/ui/button";
import { useTRPC } from "@/trpc/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import toast from "@/components/toast/toast";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

const ProjectsPage = () => {
  const trpc = useTRPC();
  const {
    data: projects,
    isLoading,
    refetch,
  } = useQuery(trpc.project.list.queryOptions());
  const [deletingProjectIds, setDeletingProjectIds] = useState<number[]>([]);
  const [projectToDelete, setProjectToDelete] = useState<{
    id: number;
    name: string;
  } | null>(null);

  const { mutate: deleteProject, isPending } = useMutation(
    trpc.project.deleteProject.mutationOptions(),
  );

  return (
    <div className="w-full space-y-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-primary">Workspace</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Projects
          </h1>
          <p className="mt-2 text-muted-foreground">
            Your applications, deployments, and production settings.
          </p>
        </div>
        <Link className={buttonVariants()} href="/projects/new">
          <PlusCircle /> New Project
        </Link>
      </div>
      {isLoading ? (
        <p className="text-muted-foreground">Loading projects…</p>
      ) : !projects?.length ? (
        <div className="glass-panel flex min-h-72 items-center justify-center">
          <Empty title="No Projects Found" />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {projects.map((project) => (
            <section key={project.id} className="glass-panel p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-muted-foreground">Project</p>
                  <h2 className="mt-1 text-xl font-semibold">{project.name}</h2>
                </div>
                {isPending && deletingProjectIds.includes(project.id) ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <DropdownMenu>
                    <DropdownMenuTrigger>
                      <Button variant="ghost">
                        <MoreVertical className="text-primary cursor-pointer" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="w-40" align="start">
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Actions</DropdownMenuLabel>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setProjectToDelete({ id: project.id, name: project.name })}
                        >
                          <Trash2 />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              <div className="mt-6 space-y-2">
                {project.apps.map((app) => {
                  const latest = [...app.deployments].sort(
                    (a, b) => b.id - a.id,
                  )[0];
                  return (
                    <Link
                      key={app.id}
                      href={`/projects/${project.id}/apps/${app.id}`}
                      className="glass-row group flex items-center justify-between px-3 py-3"
                    >
                      <div>
                        <p className="font-medium">{app.appName}</p>
                        <p className="text-xs text-muted-foreground">
                          {latest?.status ?? "Not deployed"}
                        </p>
                      </div>
                      <ArrowUpRight className="size-4 text-muted-foreground transition group-hover:text-primary" />
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={Boolean(projectToDelete)}
        onOpenChange={(open) => !open && setProjectToDelete(null)}
        title={`Delete ${projectToDelete?.name ?? "project"}?`}
        description="This removes the project and its applications. This action cannot be undone."
        confirmLabel="Delete project"
        pending={isPending}
        onConfirm={() => {
          if (!projectToDelete) return;
          const current = projectToDelete;
          setDeletingProjectIds((prev) => [...prev, current.id]);
          deleteProject({ projectId: current.id }, { onSuccess: () => {
            setDeletingProjectIds((prev) => prev.filter((id) => id !== current.id));
            setProjectToDelete(null);
            toast({ title: "Project deleted", description: `${current.name} was removed.`, variant: "success" });
            refetch();
          }, onError: (error) => { setDeletingProjectIds((prev) => prev.filter((id) => id !== current.id)); toast({ title: "Could not delete project", description: error.message, variant: "error" }); }});
        }}
      />
    </div>
  );
};

export default ProjectsPage;
