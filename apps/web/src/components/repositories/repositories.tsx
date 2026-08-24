"use client";

import usePaginate from "@/hooks/paginate/use-paginate";
import { localizer } from "@/services/localizer";
import { useTRPC } from "@/trpc/client";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Lock, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import Pagination from "../pagination/pagination";
import { Toast } from "../toast/toast";
import { Avatar, AvatarImage } from "../ui/avatar";
import { buttonVariants } from "../ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../ui/input-group";
import { Skeleton } from "../ui/skeleton";

const FrameworkIcon = ({
  provider,
  owner,
  repository,
  branch,
}: {
  provider: "github";
  owner: string;
  repository: string;
  branch: string;
}) => {
  const trpc = useTRPC();

  const { data, isLoading } = useQuery(
    trpc.framework.getFrameworkPreset.queryOptions({
      provider,
      owner,
      repo: repository,
      branch,
    }),
  );

  if (isLoading) {
    return (
      <Avatar size="sm">
        <Skeleton className="aspect-square size-full rounded-full object-cover" />
      </Avatar>
    );
  }

  return (
    <Avatar size="sm">
      <AvatarImage src={data?.iconUrl} alt={data?.framework} />
    </Avatar>
  );
};

const RepoItem = ({
  repo,
}: {
  repo: {
    id: number;
    defaultBranch: string;
    name: string;
    owner: {
      id: number;
      name: string;
    };
    private: boolean;
    slug: string;
    updatedAt: number;
    url: string;
  };
}) => {
  // const trpc = useTRPC();

  // const { mutate, isPending } = useMutation(
  //   trpc.deployment.deploy.mutationOptions(),
  // );

  // const handleImport = () => {
  //   mutate(
  //     {
  //       repoId: repo.id,
  //       repo: repo.slug,
  //       owner: repo.owner.name,
  //       branch: repo.defaultBranch,
  //     },
  //     {
  //       onError: (error) => {
  //         toast({ title: "Error", description: error.message });
  //       },
  //       onSuccess: (res) => {
  //         toast({
  //           title: "Success",
  //           description: res?.message ?? "Import Success",
  //         });
  //       },
  //     },
  //   );
  // };

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle>
          <div className="flex items-center justify-start gap-4">
            <FrameworkIcon
              provider="github"
              owner={repo.owner.name}
              repository={repo.name}
              branch={repo.defaultBranch}
            />
            <p className="text-lg">{repo.name}</p>
            {repo.private && (
              <Lock className="text-muted-foreground" size={14} />
            )}
          </div>
        </CardTitle>
        <CardAction>
          <Link
            href={{
              pathname: `/projects/new/import/${repo.id}`,
              query: {
                gitProvider: "github",
                repo: repo.name,
                branch: repo.defaultBranch,
              },
            }}
            className={buttonVariants({ variant: "secondary", size: "lg" })}
          >
            <Plus /> Import
          </Link>
        </CardAction>
      </CardHeader>

      <CardContent>
        <CardDescription>
          {repo.defaultBranch} - {localizer.formatDate(repo.updatedAt)}
        </CardDescription>
      </CardContent>
    </Card>
  );
};

const Repositories = () => {
  const [searchTerm, setSearchTerm] = useState("");

  const trpc = useTRPC();

  const { data, isLoading, isError, error } = useQuery(
    trpc.github.getUserGithubRepos.queryOptions(),
  );

  const results =
    data?.repositories.filter((repo) =>
      repo.name.toLowerCase().includes(searchTerm.toLowerCase()),
    ) ?? [];

  const { pageData } = usePaginate(results, { id: "repositories" });

  return (
    <div>
      {isLoading ? (
        <Loader2 className="animate-spin" />
      ) : (
        <>
          <div className="px-2">
            <InputGroup className="my-6">
              <InputGroupInput
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
            </InputGroup>

            {isError && error && (
              <Toast
                id="repo-error"
                variant="error"
                title="Error"
                description={error.message}
              />
            )}
          </div>
          <div className="max-h-96 overflow-auto p-2">
            {pageData.map((repo) => (
              <RepoItem key={repo.id} repo={repo} />
            ))}
          </div>
          <div className="px-2">
            <Pagination id="repositories" data={results} />
          </div>
        </>
      )}
    </div>
  );
};

export default Repositories;
