"use client";

import { useQuery } from "@tanstack/react-query";
import { GitBranch, Loader2, ShieldCheck } from "lucide-react";
import { useTRPC } from "@/trpc/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import Repositories from "./repositories";
import ConnectGithub from "../github/connect-github";

const NewProject = () => {
  const trpc = useTRPC();

  const { isLoading, data } = useQuery(
    trpc.github.getGithubConnected.queryOptions(),
  );

  return (
    <Card className="w-full border-0 bg-transparent shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitBranch className="size-4 text-primary" />
          Import GitHub repository
        </CardTitle>
        <CardDescription>
          Choose a repository from the GitHub installation connected to this
          workspace.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex min-h-48 w-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : (
          <>
            {!data?.connected && (
              <div className="rounded-2xl border border-dashed border-primary/25 bg-primary/5 p-7 text-center">
                <ShieldCheck className="mx-auto size-7 text-primary" />
                <p className="mt-3 font-medium">Connect GitHub to continue</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  NMT Deploy only requests access needed to read and deploy
                  selected repositories.
                </p>
                <div className="mt-5 flex justify-center">
                  <ConnectGithub />
                </div>
              </div>
            )}
            {data?.connected && <Repositories />}
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default NewProject;
