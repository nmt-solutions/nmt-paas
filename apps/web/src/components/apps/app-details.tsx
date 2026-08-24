"use client";

import {
  Activity,
  ExternalLink,
  FileText,
  HeartPulse,
  Plus,
  Save,
  Terminal,
  Trash2,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTRPC } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import toast from "../toast/toast";

export default function AppDetails({ appId }: { appId: number }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const router = useRouter();
  const { data: app, isLoading } = useQuery(
    trpc.app.get.queryOptions({ appId }),
  );
  const [envKey, setEnvKey] = useState("");
  const [envValue, setEnvValue] = useState("");
  const refresh = () =>
    client.invalidateQueries({ queryKey: trpc.app.get.queryKey({ appId }) });
  const addEnv = useMutation({
    ...trpc.app.addEnvVar.mutationOptions(),
    onSuccess: () => {
      setEnvKey("");
      setEnvValue("");
      refresh();
    },
  });
  const removeEnv = useMutation({
    ...trpc.app.deleteEnvVar.mutationOptions(),
    onSuccess: refresh,
  });
  const removeApp = useMutation({
    ...trpc.app.delete.mutationOptions(),
    onSuccess: () => router.push("/projects"),
  });
  const updateConfig = useMutation({
    ...trpc.app.updateConfig.mutationOptions(),
    onSuccess: refresh,
  });
  if (isLoading)
    return <p className="text-muted-foreground">Loading application…</p>;
  if (!app) return <p>Application not found.</p>;
  const latest = [...app.deployments].sort((a, b) => b.id - a.id)[0];
  const isHealthy = latest?.status === "success";
  const config = app.frameworkConfig;
  const logs = latest?.deploymentLogs ?? [];
  const runtimeLogs = logs.filter(
    (log) =>
      !/Cloning|checked out|Installing|dependencies|Building|built successfully|Deploying|deployed successfully|Command failed/i.test(
        log.message,
      ),
  );
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div className="glass-panel overflow-hidden p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm text-primary">
              {app.project?.name ?? "Project"}
            </p>
            <h1 className="mt-1 text-3xl font-semibold">{app.appName}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              GitHub repository · production application
            </p>
          </div>
          <div
            className={`rounded-full px-3 py-1.5 text-sm font-medium ${isHealthy ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" : "bg-amber-500/15 text-amber-700 dark:text-amber-300"}`}
          >
            <HeartPulse className="mr-1 inline size-4" />
            {isHealthy ? "Healthy" : (latest?.status ?? "Not deployed")}
          </div>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          {app.appDomains
            .filter((domain) => domain.env === "production")
            .map((domain) => (
              <a
                key={domain.id}
                className="glass-row inline-flex items-center gap-2 px-3 py-2 text-sm"
                href={`http://${domain.domain}`}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="size-4" />
                {domain.domain}
              </a>
            ))}
          <span className="glass-row px-3 py-2 text-sm text-muted-foreground">
            Commit {latest?.commit.slice(0, 8) ?? "—"}
          </span>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="glass-panel p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <Activity className="size-4 text-primary" />
            Runtime health
          </h2>
          <p className="mt-4 text-sm text-muted-foreground">
            The app is{" "}
            {isHealthy
              ? "reachable through its active deployment."
              : "not currently reporting a successful deployment."}
          </p>
          <p className="mt-3 font-mono text-xs text-muted-foreground">
            Last deployment: {latest?.status ?? "none"}
          </p>
        </section>
        <section className="glass-panel p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <Plus className="size-4 text-primary" />
            Environment variables
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Values are encrypted and never displayed after saving.
          </p>
          <div className="mt-4 space-y-2">
            {app.envVars.map((item) => (
              <div
                className="glass-row flex items-center justify-between px-3 py-2 text-sm"
                key={item.id}
              >
                <span className="font-mono">{item.key}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeEnv.mutate({ appId, envVarId: item.id })}
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <Input
              value={envKey}
              onChange={(event) => setEnvKey(event.target.value)}
              placeholder="KEY"
            />
            <Input
              value={envValue}
              onChange={(event) => setEnvValue(event.target.value)}
              placeholder="value"
              type="password"
            />
          </div>
          <Button
            className="mt-2"
            size="sm"
            disabled={!envKey || addEnv.isPending}
            onClick={() =>
              addEnv.mutate({ appId, key: envKey, value: envValue })
            }
          >
            Add variable
          </Button>
        </section>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <LogPanel
          appId={appId}
          title="Deployment logs"
          icon={<FileText className="size-4 text-primary" />}
          logs={logs}
        />
        <LogPanel
          appId={appId}
          title="Application logs"
          icon={<Terminal className="size-4 text-primary" />}
          logs={runtimeLogs}
          empty="Runtime output will appear here after the container starts."
        />
      </div>
      {config && (
        <section className="glass-panel p-5">
          <h2 className="mb-5 font-semibold">Build & runtime configuration</h2>
          <form
            className="grid gap-4 md:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              updateConfig.mutate({
                appId,
                appName: String(data.get("appName")),
                rootDirectory: String(data.get("rootDirectory")),
                installCommand: String(data.get("installCommand")),
                buildCommand: String(data.get("buildCommand")),
                startCommand: String(data.get("startCommand")),
                outputDirectory: String(data.get("outputDirectory")),
                port: Number(data.get("port")),
              });
            }}
          >
            <Field name="appName" label="App name" value={app.appName} />
            <Field
              name="rootDirectory"
              label="Root directory"
              value={config.rootDirectory}
            />
            <Field
              name="installCommand"
              label="Install command"
              value={config.installCommand}
            />
            <Field
              name="buildCommand"
              label="Build command"
              value={config.buildCommand}
            />
            <Field
              name="startCommand"
              label="Start command"
              value={config.startCommand}
            />
            <Field
              name="outputDirectory"
              label="Output directory"
              value={config.outputDirectory}
            />
            <Field
              name="port"
              label="Port"
              value={String(config.port)}
              type="number"
            />
            <div className="flex items-end">
              <Button type="submit" disabled={updateConfig.isPending}>
                <Save />
                Save configuration
              </Button>
            </div>
          </form>
        </section>
      )}
      <section className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5">
        <h2 className="font-semibold text-destructive">Danger zone</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Remove this app from the workspace. Its deployment history remains
          available for audit.
        </p>
        <Button
          className="mt-4"
          variant="destructive"
          onClick={() => {
            if (window.confirm(`Delete ${app.appName}?`))
              removeApp.mutate({ appId });
          }}
        >
          Delete app
        </Button>
      </section>
    </div>
  );
}
function LogPanel({
  appId,
  title,
  icon,
  logs,
  empty = "No logs yet.",
}: {
  appId: number;
  title: "Deployment logs" | "Application logs";
  icon: React.ReactNode;
  logs: { id: number; message: string }[];
  empty?: string;
}) {
  const [runtimeLogs, setRuntimeLogs] = useState<string[]>([]);

  const trpc = useTRPC();
  const {
    data: latestSuccessDeployment,
    error,
    isPending,
  } = useQuery(trpc.app.getLatestSuccessDeployment.queryOptions({ appId }));

  useEffect(() => {
    if (isPending) {
      return;
    }

    if (!latestSuccessDeployment) {
      return;
    }

    if (error) {
      toast({
        title: "Error Fetching Deployment",
        description: error.message,
        variant: "error",
      });
      return;
    }

    const controller = new AbortController();

    fetch(`/api/apps/${appId}/runtime-logs`, {
      signal: controller.signal,
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to stream runtime logs: ${response.status}`);
        }

        if (!response.body) {
          throw new Error("Runtime log stream is not available.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const event of events) {
            const dataLine = event
              .split("\n")
              .find((line) => line.startsWith("data:"));
            if (!dataLine) continue;

            const data = dataLine.slice("data:".length).trim();
            if (!data) continue;

            try {
              const parsed: unknown = JSON.parse(data);
              const log =
                typeof parsed === "string"
                  ? parsed
                  : typeof parsed === "object" &&
                      parsed !== null &&
                      "message" in parsed &&
                      typeof parsed.message === "string"
                    ? parsed.message
                    : JSON.stringify(parsed);
              setRuntimeLogs((current) => [...current, log]);
            } catch {
              setRuntimeLogs((current) => [...current, data]);
            }
          }
        }
      })
      .catch((error) => {
        if (error.name !== "AbortError") {
          console.error(error);
        }
      });

    return () => {
      controller.abort();
    };
  }, [appId, error, isPending, latestSuccessDeployment]);

  const isDeploymentLogs = title === "Deployment logs";

  return (
    <section className="glass-panel overflow-hidden">
      <div className="flex items-center gap-2 border-b border-white/10 px-5 py-4 font-semibold">
        {icon}
        {title}
      </div>
      {isDeploymentLogs && (
        <pre className="max-h-80 overflow-auto bg-black/70 p-4 font-mono text-xs leading-6 text-emerald-100">
          {logs.length ? logs.map((log) => log.message).join("\n") : empty}
        </pre>
      )}

      {!isDeploymentLogs && (
        <pre className="max-h-80 overflow-auto bg-black/70 p-4 font-mono text-xs leading-6 text-emerald-100">
          {runtimeLogs.length
            ? runtimeLogs.map((log) => log).join("\n")
            : empty}
        </pre>
      )}
    </section>
  );
}
function Field({
  name,
  label,
  value,
  type = "text",
}: {
  name: string;
  label: string;
  value: string;
  type?: string;
}) {
  return (
    <label className="grid gap-2">
      <Label htmlFor={name}>{label}</Label>
      {name.includes("Command") ? (
        <Textarea id={name} name={name} defaultValue={value} />
      ) : (
        <Input id={name} name={name} defaultValue={value} type={type} />
      )}
    </label>
  );
}
