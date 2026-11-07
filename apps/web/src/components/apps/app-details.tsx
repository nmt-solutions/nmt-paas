"use client";

import {
  Activity,
  ArrowLeft,
  Copy,
  ExternalLink,
  FileText,
  Box,
  Loader2,
  Maximize2,
  Plus,
  RefreshCw,
  Save,
  Terminal,
  Trash2,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { consumeRuntimeLogStream } from "@repo/api-sdk/runtime-logs";
import { useTRPC, useTRPCClient } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import toast from "../toast/toast";
import { PublicationPanel } from "./publication-panel";
import { deploymentStatusLabel } from "@/utils/deployment-status";
import { useDeploymentSubmission } from "@/utils/use-deployment-submission";
import { CleanupStatus } from "./cleanup-status";
import {
  appendLiveLog,
  LIVE_LOG_LINES,
  LIVE_LOG_CHARACTERS,
  type LiveLogBuffer,
} from "@/utils/live-log-buffer";
import {
  DEPLOYMENT_LOG_PAGE_SIZE,
  DEPLOYMENT_LOG_MESSAGE_CHARACTERS,
} from "@repo/database/access-layer/deployment-log-limits";

export default function AppDetails({ appId }: { appId: number }) {
  const trpc = useTRPC(); const client = useQueryClient(); const router = useRouter(); const search = useSearchParams();
  const { data: app, isLoading, isError } = useQuery({ ...trpc.app.get.queryOptions({ appId }), refetchInterval: 2_500 });
  const { data: dispatches } = useQuery({ ...trpc.deployment.dispatches.queryOptions({ appId }), refetchInterval: 2_500 });
  const submission = useDeploymentSubmission(`redeploy:${appId}`, "Redeployment queued");
  const isResolvingSubmission = submission.isResolving;
  const { data: retirement } = useQuery({ ...trpc.app.retirementStatus.queryOptions({ appId }), enabled: isError, retry: false });
  const [initialSelection, setInitialSelection] = useState<{ appId: number; deploymentId: number }>();
  const newestDeploymentId = app?.deployments.reduce((id, deployment) => Math.max(id, deployment.id), 0);
  useEffect(() => {
    if (newestDeploymentId && initialSelection?.appId !== appId) {
      setInitialSelection({ appId, deploymentId: newestDeploymentId });
    }
  }, [appId, newestDeploymentId, initialSelection?.appId]);
  const [envKey, setEnvKey] = useState(""); const [envValue, setEnvValue] = useState(""); const [deleteOpen, setDeleteOpen] = useState(false); const [needsRedeploy, setNeedsRedeploy] = useState(false); const [activeTab, setActiveTab] = useState("overview");
  const refresh = () => client.invalidateQueries({ queryKey: trpc.app.get.queryKey({ appId }) });
  const addEnv = useMutation({ ...trpc.app.addEnvVar.mutationOptions(), onSuccess: () => { setEnvKey(""); setEnvValue(""); setNeedsRedeploy(true); refresh(); toast({ title: "Environment variable saved", description: "Redeploy to apply it to the running application.", variant: "success" }); }, onError: (error) => toast({ title: "Could not save variable", description: error.message, variant: "error" }) });
  const removeEnv = useMutation({ ...trpc.app.deleteEnvVar.mutationOptions(), onSuccess: () => { setNeedsRedeploy(true); refresh(); toast({ title: "Environment variable removed", description: "Redeploy to update the running application.", variant: "success" }); }, onError: (error) => toast({ title: "Could not remove variable", description: error.message, variant: "error" }) });
  const removeApp = useMutation({ ...trpc.app.delete.mutationOptions(), onSuccess: (result) => { setDeleteOpen(false); client.setQueryData(trpc.app.retirementStatus.queryKey({ appId }), result); refresh(); void client.invalidateQueries({ queryKey: trpc.project.list.queryKey() }); toast({ title: "Application retired", description: result.retirement?.message ?? "Runtime cleanup pending.", variant: "success" }); }, onError: (error) => toast({ title: "Could not delete application", description: error.message, variant: "error" }) });
  const updateConfig = useMutation({ ...trpc.app.updateConfig.mutationOptions(), onSuccess: () => { setNeedsRedeploy(true); refresh(); toast({ title: "Configuration saved", description: "Redeploy to use the updated build settings.", variant: "success" }); }, onError: (error) => toast({ title: "Could not save configuration", description: error.message, variant: "error" }) });
  const showSubmission = (result: {
    outcome: "accepted" | "uncertain" | "rejected";
    deploymentId: number;
    message: string;
  }) => {
    submission.present(result);
    setNeedsRedeploy(false);
    void refresh();
    void client.invalidateQueries({
      queryKey: trpc.deployment.dispatches.queryKey({ appId }),
    });
    router.replace(`?deployment=${result.deploymentId}`);
  };
  const redeploy = useMutation({
    ...trpc.app.redeploy.mutationOptions(),
    onSuccess: showSubmission,
    onError: submission.unconfirmed,
  });
  const startRedeployment = async () => {
    const resolved = await submission.resolve();
    if (!resolved) return;
    if (resolved.result) showSubmission(resolved.result);
    else redeploy.mutate({ appId, submissionId: resolved.submissionId });
  };

  if (retirement?.resourceStatus === "inactive") return <section className="glass-panel mx-auto max-w-2xl space-y-4 p-8"><h1 className="text-xl font-semibold">{retirement.appName} retired</h1><p className="text-sm text-muted-foreground">The project and sibling apps remain available.</p><p role="status">{retirement.retirement?.message ?? "Runtime cleanup pending. Retry cleanup to recover."}</p><div className="flex gap-3">{retirement.retirement?.status !== "complete" && <Button disabled={removeApp.isPending} onClick={() => removeApp.mutate({ appId })}>{removeApp.isPending ? "Retrying cleanup?" : "Retry cleanup"}</Button>}<Button asChild variant="outline"><Link href="/projects">Back to projects</Link></Button></div></section>;
  if (isLoading) return <LoadingDetails />;
  if (isError || !app) return <div className="glass-panel p-8 text-center"><h1 className="font-semibold">Application unavailable</h1><p className="mt-2 text-sm text-muted-foreground">It may have been deleted or you may no longer have access.</p><Button asChild variant="outline" className="mt-5"><Link href="/projects">Back to projects</Link></Button></div>;
  const deployments = [...app.deployments].sort((a, b) => b.id - a.id); const latest = deployments[0]; const selectedDeploymentId = Number(search.get("deployment")) || (initialSelection?.appId === appId ? initialSelection.deploymentId : newestDeploymentId); const selectedDeployment = deployments.find((deployment) => deployment.id === selectedDeploymentId) ?? latest; const status = latest?.status ?? "not deployed"; const isStarted = status === "success"; const config = app.frameworkConfig;
  const selectedDispatch = dispatches?.find((dispatch) => dispatch.deploymentId === selectedDeployment?.id);
  return <div className="mx-auto w-full max-w-7xl space-y-6 pb-10">
    <Link href="/projects" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition hover:text-foreground"><ArrowLeft className="size-4" />All projects</Link>
    {selectedDispatch && selectedDispatch.state !== "dispatched" && <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm"><strong>Deployment #{selectedDispatch.deploymentId} saved. </strong>{selectedDispatch.state === "rejected" ? "Dispatch rejected by the host. Contact the operator before submitting another deployment." : `Queue confirmation pending. Automatic recovery will retry; attempts: ${selectedDispatch.attempts}. You can leave this page.`}</div>}
    <header className="glass-panel relative overflow-hidden p-6 sm:p-8"><div className="absolute -right-20 -top-24 size-64 rounded-full bg-primary/15 blur-3xl" /><div className="relative flex flex-wrap items-start justify-between gap-5"><div className="min-w-0"><p className="text-sm font-medium text-primary">{app.project?.name ?? "Project"}</p><h1 className="mt-2 truncate text-3xl font-semibold tracking-tight sm:text-4xl">{app.appName}</h1><p className="mt-3 text-sm text-muted-foreground">Production application · deployment settings and live output</p></div><div className="flex flex-wrap items-center gap-2"><StatusBadge status={status} /><Button disabled={redeploy.isPending || isResolvingSubmission || !latest} onClick={() => void startRedeployment()}>{redeploy.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}Redeploy</Button></div></div><div className="relative mt-7 flex flex-wrap gap-2">{app.appDomains.filter((domain) => domain.env === "production").map((domain) => <a key={domain.id} className="glass-row inline-flex items-center gap-2 px-3 py-2 text-sm font-medium" href={`http://${domain.domain}`} target="_blank" rel="noreferrer"><ExternalLink className="size-4 text-primary" />{domain.domain}</a>)}<span className="glass-row px-3 py-2 font-mono text-xs text-muted-foreground">{latest ? `Commit ${latest.commit.slice(0, 8)}` : "No deployment yet"}</span></div></header>
    <div className="grid gap-4 lg:grid-cols-3"><InfoCard icon={<Box />} label="Latest deployment status" value={deploymentStatusLabel(status)} note={isStarted ? "Docker accepted the container start. Application readiness has not been checked." : "Open deployment logs to follow progress."} /><InfoCard icon={<Activity />} label="Latest deployment" value={latest ? `#${latest.id}` : "—"} note={latest ? `Branch ${latest.branch}` : "Deploy this app to get started."} /><InfoCard icon={<FileText />} label="Environment" value="Production" note={`${app.envVars.length} variable${app.envVars.length === 1 ? "" : "s"} configured`} /></div>
    <CleanupStatus cleanup={selectedDeployment?.cleanup} deploymentId={selectedDeployment?.id} />
    <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-6"><TabsList variant="line" className="w-full justify-start border-b border-border/70"><TabsTrigger value="overview" className="px-4 text-sm">Overview</TabsTrigger><TabsTrigger value="deployments" className="px-4 text-sm">Deployments <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{deployments.length}</span></TabsTrigger></TabsList><TabsContent value="overview" forceMount hidden={activeTab !== "overview"} className="mt-0"><div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,0.9fr)]"><div className="space-y-6">{selectedDeployment && <PublicationPanel key={`publication-${selectedDeployment.id}`} deploymentId={selectedDeployment.id} />}<DeploymentLogPanel key={`history-${selectedDeployment?.id}`} appId={appId} deploymentId={selectedDeployment?.id} /><LogPanel appId={appId} title="Application logs" icon={<Terminal className="size-4" />} logs={[]} empty="Runtime output will appear after the container starts." />{config && <ConfigForm appId={appId} appName={app.appName} config={config} pending={updateConfig.isPending} onSave={(data) => updateConfig.mutate(data)} />}</div>
      <aside className="space-y-6">{needsRedeploy && <section className="rounded-3xl border border-amber-500/30 bg-amber-500/10 p-5"><h2 className="font-semibold text-amber-800 dark:text-amber-200">Changes are ready</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Your saved environment or build changes need a new deployment to take effect.</p><Button className="mt-4 w-full" variant="outline" disabled={redeploy.isPending || isResolvingSubmission} onClick={() => void startRedeployment()}>{redeploy.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}Redeploy now</Button></section>}<section className="glass-panel p-5"><h2 className="flex items-center gap-2 font-semibold"><Plus className="size-4 text-primary" />Environment variables</h2><p className="mt-1 text-sm text-muted-foreground">Values stay hidden after saving.</p><div className="mt-5 space-y-2">{app.envVars.length ? app.envVars.map((item) => <div className="glass-row flex items-center justify-between gap-2 px-3 py-2" key={item.id}><span className="min-w-0 truncate font-mono text-xs">{item.key}</span><Button variant="ghost" size="icon" aria-label={`Remove ${item.key}`} disabled={removeEnv.isPending} onClick={() => removeEnv.mutate({ appId, envVarId: item.id })}><Trash2 className="size-4 text-destructive" /></Button></div>) : <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">No variables added.</p>}</div><div className="mt-4 space-y-2"><Input value={envKey} onChange={(event) => setEnvKey(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))} placeholder="VARIABLE_NAME" autoCapitalize="characters" /><Input value={envValue} onChange={(event) => setEnvValue(event.target.value)} placeholder="Value" type="password" /><Button className="w-full" size="sm" disabled={!envKey || addEnv.isPending} onClick={() => addEnv.mutate({ appId, key: envKey, value: envValue })}>{addEnv.isPending && <Loader2 className="animate-spin" />}Add variable</Button></div></section><section className="rounded-3xl border border-destructive/25 bg-destructive/5 p-5"><h2 className="font-semibold text-destructive">Danger zone</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Retire this application and remove its owned runtimes. The project and sibling apps stay available.</p><Button className="mt-4" variant="destructive" onClick={() => setDeleteOpen(true)}><Trash2 />Delete app</Button></section></aside></div></TabsContent><TabsContent value="deployments" className="mt-0"><DeploymentHistory deployments={deployments} activeDeploymentId={selectedDeployment?.id} onSelect={(deploymentId) => { setActiveTab("overview"); router.replace(`?deployment=${deploymentId}`); }} /></TabsContent></Tabs>
    <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} title={`Delete ${app.appName}?`} description="This retires the app and removes its owned runtimes. The project and sibling apps stay available. Incomplete cleanup can be retried here." confirmLabel="Delete app" pending={removeApp.isPending} onConfirm={() => removeApp.mutate({ appId })} />
  </div>;
}

function ConfigForm({ appId, appName, config, pending, onSave }: { appId: number; appName: string; config: { rootDirectory: string; installCommand: string; buildCommand: string; startCommand: string; outputDirectory: string; port: number }; pending: boolean; onSave: (data: { appId: number; appName: string; rootDirectory: string; installCommand: string; buildCommand: string; startCommand: string; outputDirectory: string; port: number }) => void }) { return <section className="glass-panel p-5 sm:p-6"><div><h2 className="font-semibold">Build & runtime</h2><p className="mt-1 text-sm text-muted-foreground">Defaults are detected from your framework. Adjust only when your repository needs it.</p></div><form className="mt-6 grid gap-4 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); onSave({ appId, appName: String(data.get("appName")).trim(), rootDirectory: String(data.get("rootDirectory")).trim(), installCommand: String(data.get("installCommand")).trim(), buildCommand: String(data.get("buildCommand")).trim(), startCommand: String(data.get("startCommand")).trim(), outputDirectory: String(data.get("outputDirectory")).trim(), port: Number(data.get("port")) }); }}><Field name="appName" label="App name" value={appName} /><Field name="rootDirectory" label="Root directory" value={config.rootDirectory} /><Field name="installCommand" label="Install command" value={config.installCommand} /><Field name="buildCommand" label="Build command" value={config.buildCommand} /><Field name="startCommand" label="Start command" value={config.startCommand} /><Field name="outputDirectory" label="Output directory" value={config.outputDirectory} /><Field name="port" label="Port" value={String(config.port)} type="number" /><div className="flex items-end"><Button type="submit" disabled={pending}>{pending && <Loader2 className="animate-spin" />}<Save />Save changes</Button></div></form></section>; }
function StatusBadge({ status }: { status: string }) { const good = status === "success"; const pending = ["queued", "building", "deploying"].includes(status.toLowerCase()); return <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium ${good ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : pending ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-muted bg-muted/60 text-muted-foreground"}`}><span className={`size-2 rounded-full ${good ? "bg-emerald-500" : pending ? "animate-pulse bg-amber-500" : "bg-muted-foreground"}`} />{deploymentStatusLabel(status)}</div>; }
function InfoCard({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: string; note: string }) { return <section className="glass-panel p-5"><div className="flex items-center gap-2 text-primary">{icon}<span className="text-sm font-medium text-muted-foreground">{label}</span></div><p className="mt-4 text-xl font-semibold capitalize">{value}</p><p className="mt-1 text-sm text-muted-foreground">{note}</p></section>; }
function DeploymentHistory({ deployments, activeDeploymentId, onSelect }: { deployments: { id: number; status: string; branch: string; commit: string; createdAt: Date | string | null }[]; activeDeploymentId?: number; onSelect: (deploymentId: number) => void }) { return <section className="glass-panel overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-5 sm:px-6"><div><h2 className="font-semibold">Deployment history</h2><p className="mt-1 text-sm text-muted-foreground">Every production release, newest first. Success confirms container start. Application readiness has not been checked.</p></div><span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">{deployments.length} total</span></div>{deployments.length ? <div className="divide-y divide-border/70">{deployments.map((deployment) => { const isActive = deployment.id === activeDeploymentId; const isSuccess = deployment.status === "success"; const isRunning = ["queued", "building", "deploying"].includes(deployment.status.toLowerCase()); const timestamp = deployment.createdAt ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(deployment.createdAt)) : "Unknown time"; return <button type="button" key={deployment.id} onClick={() => onSelect(deployment.id)} className={`flex w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-primary/5 sm:px-6 ${isActive ? "bg-primary/5" : ""}`}><span className={`size-2.5 shrink-0 rounded-full ${isSuccess ? "bg-emerald-500" : isRunning ? "animate-pulse bg-amber-500" : "bg-destructive"}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="font-medium">Deployment #{deployment.id}</span><span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize text-muted-foreground">{deploymentStatusLabel(deployment.status)}</span>{isActive && <span className="text-xs font-medium text-primary">Viewing logs</span>}</div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground"><span>{deployment.branch}</span><span>{deployment.commit.slice(0, 8)}</span><span className="font-sans">{timestamp}</span></div></div><span className="text-sm font-medium text-primary">View logs</span></button>; })}</div> : <div className="px-6 py-12 text-center text-sm text-muted-foreground">No deployments yet.</div>}</section>; }
function LoadingDetails() { return <div className="space-y-5"><div className="glass-panel h-48 animate-pulse" /><div className="grid gap-4 md:grid-cols-3">{[1, 2, 3].map((item) => <div className="glass-panel h-32 animate-pulse" key={item} />)}</div></div>; }
function DeploymentLogPanel({
  appId,
  deploymentId,
}: {
  appId: number;
  deploymentId?: number;
}) {
  const client = useTRPCClient();
  type Page = Awaited<ReturnType<typeof client.app.deploymentLogs.query>>;
  const [page, setPage] = useState<
    Page & { hasOlder: boolean; hasNewer: boolean }
  >({
    logs: [],
    hasMore: false,
    oldestCursor: null,
    newestCursor: null,
    hasOlder: false,
    hasNewer: false,
  });
  const [cursor, setCursor] = useState<{
    before?: number;
    after?: number;
    following: boolean;
  }>({ following: true });
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!deploymentId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let newest = 0;
    const read = async (initial: boolean) => {
      try {
        if (initial) setLoading(true);
        const result = await client.app.deploymentLogs.query(
          {
            appId,
            deploymentId,
            limit: DEPLOYMENT_LOG_PAGE_SIZE,
            ...(initial
              ? { before: cursor.before, after: cursor.after }
              : { after: newest }),
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setError(undefined);
        if (initial) {
          setPage({
            ...result,
            hasOlder: cursor.after !== undefined || result.hasMore,
            hasNewer:
              cursor.after !== undefined
                ? result.hasMore
                : cursor.before !== undefined,
          });
        } else if (result.logs.length) {
          setPage((current) => {
            const combined = [...current.logs, ...result.logs];
            const logs = combined.slice(-DEPLOYMENT_LOG_PAGE_SIZE);
            return {
              ...result,
              logs,
              oldestCursor: logs[0]?.id ?? null,
              hasOlder:
                current.hasOlder || combined.length > DEPLOYMENT_LOG_PAGE_SIZE,
              hasNewer: false,
            };
          });
        }
        newest = result.newestCursor ?? newest;
        // Older windows are stable. Following requests only IDs after the last read.
        if (cursor.following)
          timer = setTimeout(
            () => void read(false),
            result.hasMore && !initial ? 0 : 2_500,
          );
      } catch {
        if (!controller.signal.aborted) {
          setPage({
            logs: [],
            hasMore: false,
            oldestCursor: null,
            newestCursor: null,
            hasOlder: false,
            hasNewer: false,
          });
          setError(
            "Deployment history is unavailable. Select Latest logs to retry.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void read(true);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [appId, deploymentId, client, cursor]);
  const notice = [
    cursor.following && page.hasOlder
      ? "Earlier records omitted from the following window; use Older logs to read them."
      : "",
    page.logs.some((log) => log.truncated)
      ? `Some messages truncated to ${DEPLOYMENT_LOG_MESSAGE_CHARACTERS.toLocaleString("en-US")} characters.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <LogPanel
      appId={appId}
      title="Deployment logs"
      icon={<FileText className="size-4" />}
      logs={page.logs.map((log) => ({
        ...log,
        message: log.message + (log.truncated ? "\n[message truncated]" : ""),
      }))}
      highlightedDeploymentId={deploymentId}
      detail={
        deploymentId
          ? `${cursor.following ? "Following" : "History"} · deployment #${deploymentId}`
          : "No deployment selected"
      }
      notice={notice}
      error={error}
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || !page.oldestCursor || !page.hasOlder}
            onClick={() =>
              setCursor({ before: page.oldestCursor!, following: false })
            }
          >
            Older logs
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || !page.newestCursor || !page.hasNewer}
            onClick={() =>
              setCursor({ after: page.newestCursor!, following: false })
            }
          >
            Newer logs
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || !deploymentId}
            onClick={() => setCursor({ following: true })}
          >
            Latest logs
          </Button>
        </>
      }
    />
  );
}

function LogPanel({
  appId,
  title,
  icon,
  logs,
  empty = "No logs yet.",
  highlightedDeploymentId,
  actions,
  notice,
  error,
  detail,
}: {
  appId: number;
  title: "Deployment logs" | "Application logs";
  icon: React.ReactNode;
  logs: { id: number; message: string }[];
  empty?: string;
  highlightedDeploymentId?: number;
  actions?: React.ReactNode;
  notice?: string;
  error?: string;
  detail?: string;
}) {
  const [runtimeLogs, setRuntimeLogs] = useState<LiveLogBuffer>({
    lines: [],
    truncated: false,
  });
  const [runtimeId, setRuntimeId] = useState<number>();
  const [streamStatus, setStreamStatus] = useState("Connecting");
  const [streamError, setStreamError] = useState<string>();
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const isDeploymentLogs = title === "Deployment logs";
  useEffect(() => {
    if (isDeploymentLogs) return;
    const controller = new AbortController();
    fetch(`/api/apps/${appId}/runtime-logs`, {
      signal: controller.signal,
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (!response.ok || !response.body)
          throw new Error("Runtime log stream is unavailable.");
        await consumeRuntimeLogStream(response.body, (event) => {
          if (controller.signal.aborted) return;
          if (event.type === "runtime") {
            setRuntimeId(event.deploymentId);
            setRuntimeLogs({ lines: [], truncated: false });
            setStreamError(undefined);
            setStreamStatus("Live");
          } else if (event.type === "log") {
            setRuntimeLogs((current) => appendLiveLog(current, event.text));
          } else if (event.type === "error") {
            setStreamError(event.message);
            setStreamStatus("Stream failed");
          } else {
            setStreamStatus(
              event.reason === "eof" ? "Stream ended" : "Stream failed",
            );
          }
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setStreamError(
          "Runtime log connection failed. Reconnect to select the current runtime.",
        );
        setStreamStatus("Stream failed");
      });
    return () => controller.abort();
  }, [appId, isDeploymentLogs, connectionAttempt]);
  const content = isDeploymentLogs
    ? logs.length
      ? logs.map((log) => log.message).join("\n")
      : empty
    : runtimeLogs.lines.length
      ? runtimeLogs.lines.join("\n")
      : empty;
  const description = isDeploymentLogs
    ? highlightedDeploymentId
      ? `Live ? following deployment #${highlightedDeploymentId}`
      : "Live build, deploy, and error output"
    : `${streamStatus}${runtimeId ? ` ? deployment #${runtimeId}` : ""}`;
  return (
    <>
      <section className="glass-panel overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 font-semibold">
              <span className="text-primary">{icon}</span>
              {title}
            </h2>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              {isDeploymentLogs && (
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
              )}
              {detail ?? description}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {actions}
            {!isDeploymentLogs && (
              <Button
                variant="ghost"
                size="sm"
                title="Start a new subscription to the latest successful runtime"
                onClick={() => {
                  setRuntimeLogs({ lines: [], truncated: false });
                  setRuntimeId(undefined);
                  setStreamError(undefined);
                  setStreamStatus("Connecting");
                  setConnectionAttempt((current) => current + 1);
                }}
              >
                <RefreshCw className="size-4" />
                Reconnect
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label={`View ${title} fullscreen`}
              onClick={() => setFullscreen(true)}
            >
              <Maximize2 className="size-4" />
            </Button>
          </div>
        </div>
        {(error || (streamError && !isDeploymentLogs)) && (
          <p role="alert" className="px-5 py-3 text-sm text-destructive">
            {error || streamError}
          </p>
        )}
        {notice && (
          <p role="status" className="px-5 py-3 text-xs text-muted-foreground">
            {notice}
          </p>
        )}
        {!isDeploymentLogs && runtimeLogs.truncated && (
          <p role="status" className="px-5 py-3 text-xs text-muted-foreground">
            Earlier output truncated. Showing at most{" "}
            {LIVE_LOG_LINES.toLocaleString("en-US")} lines and{" "}
            {LIVE_LOG_CHARACTERS.toLocaleString("en-US")} characters from this
            subscription.
          </p>
        )}
        <LogOutput content={content} />
      </section>
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent className="h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] p-0">
          <DialogHeader className="border-b border-border/70 p-5">
            <DialogTitle className="flex items-center gap-2">
              <span className="text-primary">{icon}</span>
              {title}
            </DialogTitle>
            <DialogDescription>
              {detail ?? description}
              {streamError ? ` ? ${streamError}` : ""}
              {notice ? ` · ${notice}` : ""}
              {!isDeploymentLogs && runtimeLogs.truncated
                ? " · Earlier output truncated."
                : ""}
            </DialogDescription>
          </DialogHeader>
          <LogOutput content={content} fullscreen />
        </DialogContent>
      </Dialog>
    </>
  );
}
function LogOutput({ content, fullscreen = false }: { content: string; fullscreen?: boolean }) { const [copied, setCopied] = useState(false); return <div className={`relative bg-slate-950 ${fullscreen ? "h-[calc(100%-5.75rem)]" : ""}`}><Button variant="ghost" size="sm" className="absolute right-3 top-3 z-10 bg-white/10 text-slate-100 hover:bg-white/20 hover:text-white" onClick={() => { navigator.clipboard.writeText(content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }).catch(() => undefined); }}><Copy className="size-3.5" />{copied ? "Copied" : "Copy"}</Button><pre className={`${fullscreen ? "h-full" : "max-h-96"} overflow-auto p-5 pr-20 font-mono text-xs leading-6 whitespace-pre-wrap text-emerald-100`}>{content}</pre></div>; }
function Field({ name, label, value, type = "text" }: { name: string; label: string; value: string; type?: string }) { return <label className="grid gap-2"><Label htmlFor={name}>{label}</Label>{name.includes("Command") ? <Textarea id={name} name={name} defaultValue={value} /> : <Input id={name} name={name} defaultValue={value} type={type} />}</label>; }
