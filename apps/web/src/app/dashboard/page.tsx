"use client";

import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Box,
  CircleCheck,
  Clock3,
  GitCommitHorizontal,
  Plus,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";
import { Button } from "@/components/ui/button";

export default function Dashboard() {
  const trpc = useTRPC();
  const { data: projects, isLoading } = useQuery(
    trpc.project.list.queryOptions(),
  );
  const apps =
    projects?.flatMap((project) =>
      project.apps.map((app) => ({
        ...app,
        projectName: project.name,
        projectId: project.id,
      })),
    ) ?? [];
  const deployments = apps.flatMap((app) => app.deployments);
  const healthy = deployments.filter(
    (deployment) => deployment.status === "success",
  ).length;
  return (
    <div className="mx-auto w-full max-w-7xl space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="text-sm font-medium text-primary">Overview</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Good {greeting()}, deployer.
          </h1>
          <p className="mt-2 text-muted-foreground">
            A calm view of what is running across your workspace.
          </p>
        </div>
        <Button asChild>
          <Link href="/projects/new">
            <Plus />
            New project
          </Link>
        </Button>
      </section>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          icon={<Box />}
          label="Applications"
          value={String(apps.length)}
          helper="in your workspace"
        />
        <Metric
          icon={<CircleCheck />}
          label="Healthy releases"
          value={String(healthy)}
          helper="currently successful"
        />
        <Metric
          icon={<GitCommitHorizontal />}
          label="Deployments"
          value={String(deployments.length)}
          helper="all-time history"
        />
        <Metric
          icon={<Activity />}
          label="Availability"
          value={
            deployments.length
              ? `${Math.round((healthy / deployments.length) * 100)}%`
              : "—"
          }
          helper="successful deploys"
        />
      </section>
      <section className="grid gap-6 xl:grid-cols-[1.4fr_.6fr]">
        <div className="glass-panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-emerald-950/10 px-5 py-4 dark:border-white/10">
            <div>
              <h2 className="font-semibold">Your applications</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                The latest production state for each app.
              </p>
            </div>
            <Link className="text-sm font-medium text-primary" href="/projects">
              View all
            </Link>
          </div>
          {isLoading ? (
            <div className="p-6 text-sm text-muted-foreground">
              Loading workspace…
            </div>
          ) : apps.length ? (
            <div className="divide-y divide-emerald-950/10 dark:divide-white/10">
              {apps.slice(0, 5).map((app) => {
                const latest = [...app.deployments].sort(
                  (a, b) => b.id - a.id,
                )[0];
                return (
                  <Link
                    key={app.id}
                    href={`/projects/${app.projectId}/apps/${app.id}`}
                    className="group flex items-center gap-4 px-5 py-4 transition hover:bg-emerald-500/5"
                  >
                    <span
                      className={`size-2 rounded-full ${latest?.status === "success" ? "bg-emerald-500" : "bg-amber-400"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{app.appName}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {app.projectName} ·{" "}
                        {latest?.commit.slice(0, 8) ?? "No deployments"}
                      </p>
                    </div>
                    <span className="hidden rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 sm:block dark:text-emerald-300">
                      {latest?.status ?? "idle"}
                    </span>
                    <ArrowRight className="size-4 text-muted-foreground transition group-hover:text-primary" />
                  </Link>
                );
              })}
            </div>
          ) : (
            <EmptyWorkspace />
          )}
        </div>
        <aside className="glass-panel p-5">
          <div className="flex items-center gap-2">
            <Clock3 className="size-4 text-primary" />
            <h2 className="font-semibold">Start shipping</h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Your first deployment takes only a few moments. We’ll detect the
            framework and keep every release tied to an exact commit.
          </p>
          <ol className="mt-6 space-y-4 text-sm">
            <Step number="01" text="Connect GitHub" />
            <Step number="02" text="Choose a repository" />
            <Step number="03" text="Deploy to production" />
          </ol>
          <Button className="mt-7 w-full" variant="outline" asChild>
            <Link href="/projects/new">
              Import repository <ArrowRight />
            </Link>
          </Button>
        </aside>
      </section>
    </div>
  );
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}
function Metric({
  icon,
  label,
  value,
  helper,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <div className="glass-panel p-5">
      <div className="flex items-center justify-between text-muted-foreground">
        <span className="text-sm">{label}</span>
        <span className="text-primary">{icon}</span>
      </div>
      <p className="mt-5 text-3xl font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{helper}</p>
    </div>
  );
}
function Step({ number, text }: { number: string; text: string }) {
  return (
    <li className="flex items-center gap-3">
      <span className="grid size-7 place-items-center rounded-full bg-primary/10 font-mono text-xs text-primary">
        {number}
      </span>
      {text}
    </li>
  );
}
function EmptyWorkspace() {
  return (
    <div className="px-5 py-12 text-center">
      <Box className="mx-auto size-7 text-primary" />
      <p className="mt-3 font-medium">Your workspace is ready.</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Import a repository to create the first app.
      </p>
      <Button className="mt-5" size="sm" asChild>
        <Link href="/projects/new">Import repository</Link>
      </Button>
    </div>
  );
}
