"use client";

import { FrameworkConfigPreset } from "@/models/framework";
import { useTRPC } from "@/trpc/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  File,
  FolderOpen,
  GitBranch,
  Loader2,
  Minus,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import Link from "next/dist/client/link";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import toast, { Toast } from "../toast/toast";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Separator } from "../ui/separator";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../ui/accordion";
import { parseEnvInput } from "@/utils/parse-env-vars";

const getRepoProviderName = (gitProvider: "github") => {
  switch (gitProvider) {
    case "github":
      return "GitHub";
    default:
      return gitProvider;
  }
};

const ImportRepository = ({
  gitProvider,
  repoId,
  repo,
  branch,
}: {
  gitProvider: "github";
  repoId: string;
  repo: string;
  branch: string;
}) => {
  const [projectName, setProjectName] = useState(repo.toLowerCase());
  const [rootDirEnabled, setRootDirEnabled] = useState(false);
  const [rootDir, setRootDir] = useState("./");
  const [frameworkPreset, setFrameworkPreset] =
    useState<FrameworkConfigPreset | null>(null);
  const [envVarsFields, setEnvVarsFields] = useState<number[]>([Math.random()]);
  const [envVars, setEnvVars] = useState<{
    [key: number]: { key: string; value: string };
  }>({});
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [buildCommandEnabled, setBuildCommandEnabled] = useState(false);
  const [buildCommand, setBuildCommand] = useState("");
  const [outputDirectoryEnabled, setOutputDirectoryEnabled] = useState(false);
  const [outputDirectory, setOutputDirectory] = useState("");
  const [installCommandEnabled, setInstallCommandEnabled] = useState(false);
  const [installCommand, setInstallCommand] = useState("");

  const trpc = useTRPC();

  const { data, isPending, isError, error } = useQuery(
    trpc.git.getRepository.queryOptions({
      gitProvider,
      repoId,
      repo,
      branch,
    }),
  );

  const {
    data: frameworksData,
    isLoading,
    isError: isFrameworksError,
    error: frameworksError,
  } = useQuery(trpc.framework.getFrameworks.queryOptions());

  useEffect(() => {
    if (data?.frameworkPreset) {
      setFrameworkPreset(data.frameworkPreset);
    }
  }, [data?.frameworkPreset]);

  const { isPending: isDeploying, mutate: deploy } = useMutation(
    trpc.deployment.deploy.mutationOptions(),
  );

  const importEnvVars = (content: string, evid: number) => {
    const res = parseEnvInput(content);

    if (res.type === "single") {
      setEnvVars((prev) => ({
        ...prev,
        [evid]: {
          key: res.data.key,
          value: res.data.value,
        },
      }));

      return;
    }

    // Remove current empty field if needed
    setEnvVars((prev) => {
      const updated = { ...prev };
      delete updated[evid];
      return updated;
    });

    setEnvVarsFields((prev) => prev.filter((id) => id !== evid));

    // Add parsed env vars
    const newEntries = res.data.map((evd) => ({
      id: Math.random(),
      ...evd,
    }));

    setEnvVarsFields((prev) => [...prev, ...newEntries.map((x) => x.id)]);

    setEnvVars((prev) => {
      const updated = { ...prev };

      newEntries.forEach((entry) => {
        updated[entry.id] = {
          key: entry.key,
          value: entry.value,
        };
      });

      return updated;
    });
  };

  const deployProject = () => {
    const envVarsArray = envVarsFields
      .map((id) => envVars[id])
      .filter((ev) => ev?.key && ev?.value)
      .map((ev) => ({ key: ev!.key, value: ev!.value }));

    if (frameworkPreset === null) {
      toast({
        title: "Framework Preset Required",
        description: "Please select a framework preset before deploying.",
        variant: "error",
      });
      return;
    }

    deploy(
      {
        repoId: parseInt(repoId),
        repo,
        owner: data?.repository.owner.name ?? "",
        branch,
        envVars: envVarsArray,
        frameworkConfig: { ...frameworkPreset },
      },
      {
        onError: (err) => {
          toast({
            title: "Deployment Error",
            description: err.message,
            variant: "error",
          });
        },
        onSuccess: () => {
          toast({
            title: "Deployment Queued",
            description: "Your deployment has been queued successfully.",
            variant: "success",
          });
        },
      },
    );
  };

  if (isError) {
    return (
      <Toast
        id="import-repository-error"
        variant="error"
        title="Error"
        description={error.message}
      />
    );
  }

  if (isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Loading...</CardTitle>
        </CardHeader>
      </Card>
    );
  }

  if (isFrameworksError) {
    return (
      <Toast
        id="frameworks-error"
        variant="error"
        title="Error"
        description={frameworksError.message}
      />
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Loading...</CardTitle>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New Project</CardTitle>
      </CardHeader>
      <Card className="bg-muted">
        <CardContent>
          <p>Importing from {getRepoProviderName(gitProvider)}</p>
          <div className="flex items-center gap-8">
            <Link href={data.repository.url} target="_blank">
              <div className="flex items-center gap-2">
                <Image
                  height={16}
                  width={16}
                  src={`/assets/git/${gitProvider}.svg`}
                  alt={gitProvider}
                />
                <p className="mt-0.5">
                  {data.repository.owner.name}/{data.repository.slug}
                </p>
              </div>
            </Link>
            <div className="flex items-center gap-2">
              <GitBranch className="size-4 text-muted-foreground" />
              <p className="mt-0.5">{branch}</p>
            </div>
            {rootDir ? (
              <div className="flex items-center gap-2">
                <FolderOpen className="size-4 text-muted-foreground" />
                <p className="mt-0.5">{rootDir}</p>
              </div>
            ) : (
              <></>
            )}
          </div>
        </CardContent>
      </Card>
      <CardContent>
        <Label htmlFor="project-name" className="my-1 text-muted-foreground">
          Project Name
        </Label>
        <Input
          id="project-name"
          placeholder="my-project"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
        />
      </CardContent>
      <Separator />
      <CardContent>
        <Label htmlFor="project-name" className="my-1 text-muted-foreground">
          Application Preset
        </Label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="w-full flex justify-between">
              <span className="flex items-center gap-2">
                <Image
                  height={16}
                  width={16}
                  src={frameworkPreset?.iconUrl ?? ""}
                  alt={frameworkPreset?.framework ?? "unknown"}
                />
                <p className="mt-0.5">
                  {frameworkPreset
                    ? frameworkPreset.framework === "unknown"
                      ? "Other"
                      : frameworkPreset.framework.at(0)?.toUpperCase() +
                        frameworkPreset.framework.slice(1)
                    : "Select a preset"}
                </p>
              </span>
              <ChevronDown className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {frameworksData?.map((framework) => (
              <DropdownMenuItem
                key={framework.framework}
                onClick={() => setFrameworkPreset(framework)}
              >
                <div className="flex items-center gap-2">
                  <Image
                    height={16}
                    width={16}
                    src={framework.iconUrl}
                    alt={framework.framework}
                  />
                  <p className="mt-0.5">
                    {framework.framework === "unknown"
                      ? "Other"
                      : framework.framework.at(0)?.toUpperCase() +
                        framework.framework.slice(1)}
                  </p>
                </div>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </DropdownMenuContent>
        </DropdownMenu>
      </CardContent>
      <Separator />
      <CardContent>
        <Label htmlFor="root-directory" className="my-1 text-muted-foreground">
          Root Directory
        </Label>
        <div className="flex">
          <Input
            id="root-directory"
            disabled={!rootDirEnabled}
            placeholder="./"
            value={rootDir}
            onChange={(e) => setRootDir(e.target.value)}
          />
          <Button
            variant="outline"
            onClick={() => {
              if (rootDirEnabled) {
                setRootDir("./");
                setRootDirEnabled(false);
              } else {
                setRootDirEnabled(true);
              }
            }}
          >
            {rootDirEnabled ? <X /> : <Pencil />}
          </Button>
        </div>
      </CardContent>

      <Separator />

      <CardContent>
        <Accordion type="multiple" className="rounded-lg border">
          <AccordionItem
            value="build"
            className="border-b px-4 last:border-b-0"
          >
            <AccordionTrigger>Build & Output Settings</AccordionTrigger>
            <AccordionContent className="min-h-max max-h-max">
              <Label
                htmlFor="build-command"
                className="my-1 text-muted-foreground"
              >
                Build Command
              </Label>
              <div className="flex">
                <Input
                  id="build-command"
                  disabled={!buildCommandEnabled}
                  placeholder="`pnpm build` or `npm run build` or `yarn build`"
                  value={buildCommand}
                  onChange={(e) => setBuildCommand(e.target.value)}
                />
                <Button
                  variant="outline"
                  onClick={() => {
                    if (buildCommandEnabled) {
                      setBuildCommand("");
                      setBuildCommandEnabled(false);
                    } else {
                      setBuildCommandEnabled(true);
                    }
                  }}
                >
                  {buildCommandEnabled ? <X /> : <Pencil />}
                </Button>
              </div>

              <Label
                htmlFor="output-directory"
                className="my-1 mt-4 text-muted-foreground"
              >
                Output Directory
              </Label>
              <div className="flex">
                <Input
                  id="output-directory"
                  disabled={!outputDirectoryEnabled}
                  className="mb-4"
                  placeholder="dist"
                  value={outputDirectory}
                  onChange={(e) => setOutputDirectory(e.target.value)}
                />
                <Button
                  variant="outline"
                  onClick={() => {
                    if (outputDirectoryEnabled) {
                      setOutputDirectory("");
                      setOutputDirectoryEnabled(false);
                    } else {
                      setOutputDirectoryEnabled(true);
                    }
                  }}
                >
                  {outputDirectoryEnabled ? <X /> : <Pencil />}
                </Button>
              </div>

              <Label
                htmlFor="install-command"
                className="my-1 text-muted-foreground"
              >
                Install Command
              </Label>
              <div className="flex">
                <Input
                  id="install-command"
                  disabled={!installCommandEnabled}
                  placeholder="`npm install` or `pnpm install` or `yarn install`"
                  value={installCommand}
                  onChange={(e) => setInstallCommand(e.target.value)}
                />
                <Button
                  variant="outline"
                  onClick={() => {
                    if (installCommandEnabled) {
                      setInstallCommand("");
                      setInstallCommandEnabled(false);
                    } else {
                      setInstallCommandEnabled(true);
                    }
                  }}
                >
                  {installCommandEnabled ? <X /> : <Pencil />}
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="env" className="border-b px-4 last:border-b-0">
            <AccordionTrigger>Environment Variables</AccordionTrigger>
            <AccordionContent className="min-h-max max-h-max">
              {envVarsFields.map((ev) => (
                <div key={ev}>
                  <div className="flex items-center">
                    <Input
                      id={`key-${ev}`}
                      className="my-2"
                      placeholder="Key"
                      value={envVars[ev]?.key ?? ""}
                      onChange={(e) => {
                        if (e.target.value.includes("=")) {
                          return;
                        }

                        setEnvVars((prev) => ({
                          ...prev,
                          [ev]: {
                            key: e.target.value,
                            value: prev[ev]?.value ?? "",
                          },
                        }));
                      }}
                      onPaste={(e) => {
                        const pastedText = e.clipboardData.getData("text");

                        // Plain key/value paste
                        // Example:
                        // DEV_DATABASE_URL
                        // some-secret-value
                        if (!pastedText.trim().includes("=")) {
                          return;
                        }

                        importEnvVars(pastedText, ev);
                      }}
                    />
                    <Button
                      variant="outline"
                      onClick={() =>
                        setEnvVarsFields((prev) =>
                          prev.filter((evf) => ev !== evf),
                        )
                      }
                    >
                      <Minus />
                    </Button>
                  </div>
                  <Input
                    id={`value-${ev}`}
                    placeholder="Value"
                    value={envVars[ev]?.value ?? ""}
                    onChange={(e) =>
                      setEnvVars((prev) => ({
                        ...prev,
                        [ev]: {
                          key: prev[ev]?.key ?? "",
                          value: e.target.value,
                        },
                      }))
                    }
                  />
                  <Separator className="my-4" />
                </div>
              ))}
              <div className="flex justify-end gap-4 ">
                <Input
                  ref={inputRef}
                  hidden
                  type="file"
                  accept=".env,text/plain"
                  multiple={false}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];

                    if (!file) return;

                    const fileContent = await file.text();

                    const evid = Math.random();
                    setEnvVarsFields((prev) => [...prev]);

                    importEnvVars(fileContent, evid);
                  }}
                />
                <Button
                  variant="outline"
                  onClick={() => {
                    inputRef.current?.click();
                  }}
                >
                  <File />
                  Import .env File
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    setEnvVarsFields((prev) => [...prev, Math.random()])
                  }
                >
                  <Plus />
                  Add Env Variable
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        <div className="my-4">
          <Button
            disabled={isDeploying}
            className="w-full rounded-lg"
            onClick={deployProject}
          >
            {isDeploying && <Loader2 className="animate-spin" />}
            {isDeploying ? "Deploying..." : "Deploy"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export default ImportRepository;
