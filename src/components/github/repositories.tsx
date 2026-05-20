"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, Lock, Plus, Search } from "lucide-react";
import { useState } from "react";
import usePaginate from "@/hooks/paginate/use-paginate";
import { localizer } from "@/services/localizer";
import { useTRPC } from "@/trpc/client";
import Pagination from "../pagination/pagination";
import { Toast } from "../toast/toast";
import { Avatar, AvatarImage } from "../ui/avatar";
import { Button } from "../ui/button";
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
      repository,
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
              <Card key={repo.id}>
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
                    <Button variant="secondary" size="lg">
                      <Plus /> Import
                    </Button>
                  </CardAction>
                </CardHeader>

                <CardContent>
                  <CardDescription>
                    {repo.defaultBranch} -{" "}
                    {localizer.formatDate(repo.updatedAt)}
                  </CardDescription>
                </CardContent>
              </Card>
            ))}
          </div>
          <Pagination id="repositories" data={results} />
        </>
      )}
    </div>
  );
};

export default Repositories;
