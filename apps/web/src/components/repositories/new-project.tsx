"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
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
    <Card className="w-full max-w-sm md:max-w-lg lg:max-w-xl xl:max-w-3xl">
      <CardHeader>
        <CardTitle>Import Git Repository</CardTitle>
        <CardDescription>
          Select a Git provider to import an existing project from a Git
          Repository.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-full w-full justify-center items-center">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          <>
            {!data?.connected && <ConnectGithub />}
            {data?.connected && <Repositories />}
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default NewProject;
