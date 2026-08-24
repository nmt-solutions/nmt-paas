"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { HardDrive, MemoryStick, Server, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTRPC } from "@/trpc/client";

export default function AdminPage() {
  const trpc = useTRPC();
  const [resource, setResource] = useState<"containers" | "images" | "volumes">(
    "containers",
  );
  const { data, isLoading, error, refetch } = useQuery(
    trpc.admin.host.queryOptions(),
  );
  const inventory = useQuery(trpc.admin.resources.queryOptions({ resource }));
  const remove = useMutation({
    ...trpc.admin.deleteResource.mutationOptions(),
    onSuccess: () => inventory.refetch(),
  });

  useEffect(() => {
    const timer = setInterval(() => {
      refetch();
    }, 3000);

    return () => clearInterval(timer);
  }, [refetch]);

  if (isLoading)
    return <p className="text-muted-foreground">Loading host health…</p>;
  if (error)
    return (
      <p className="text-destructive">
        Admin access or Docker host unavailable: {error.message}
      </p>
    );
  const host = data?.data;
  const memoryPercent = host
    ? Math.round((host.memory.used / host.memory.total) * 100)
    : 0;
  const items = (inventory.data?.data ?? []) as {
    Id?: string;
    Name?: string;
    Names?: string[];
    Repository?: string;
  }[];
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div>
        <p className="text-sm font-medium text-primary">Administration</p>
        <h1 className="mt-1 text-3xl font-semibold">Host health</h1>
        <p className="mt-2 text-muted-foreground">
          Live capacity and Docker resources on the deployment host.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Metric
          icon={<Server />}
          label="Containers running"
          value={`${host?.docker.runningContainers ?? 0} / ${host?.docker.containers ?? 0}`}
        />
        <Metric
          icon={<MemoryStick />}
          label="Memory in use"
          value={`${memoryPercent}%`}
        />
        <Metric
          icon={<HardDrive />}
          label="Docker images / volumes"
          value={`${host?.docker.images ?? 0} / ${host?.docker.volumes ?? 0}`}
        />
      </div>
      <div className="glass-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Docker resources</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Deletion is immediate and cannot be undone.
            </p>
          </div>
          <select
            className="rounded-lg border bg-background px-3 py-2 text-sm"
            value={resource}
            onChange={(event) =>
              setResource(event.target.value as typeof resource)
            }
          >
            {["containers", "images", "volumes"].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </div>
        <div className="mt-4 divide-y">
          {items.map((item) => {
            const id = item.Id ?? item.Name ?? "";
            return (
              <div
                key={id}
                className="flex items-center justify-between gap-3 py-3 text-sm"
              >
                <span className="min-w-0 truncate font-mono">
                  {item.Names?.[0] ?? item.Repository ?? item.Name ?? id}
                </span>
                <button
                  className="rounded-md p-2 text-destructive hover:bg-destructive/10"
                  aria-label={`Delete ${id}`}
                  onClick={() => {
                    if (window.confirm(`Delete ${id}?`))
                      remove.mutate({ resource, id });
                  }}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            );
          })}
          {!items.length && (
            <p className="py-4 text-sm text-muted-foreground">
              No {resource} found.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="glass-panel p-5">
      <div className="flex items-center gap-2 text-primary">
        {icon}
        <span className="text-sm">{label}</span>
      </div>
      <p className="mt-5 text-3xl font-semibold">{value}</p>
    </div>
  );
}
