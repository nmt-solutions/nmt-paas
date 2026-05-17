"use client";

import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useTRPC } from "@/trpc/client";
import { Toast } from "../toast/toast";
import { Button } from "../ui/button";

const Repositories = () => {
  const trpc = useTRPC();

  const {
    data,
    mutate: fetch,
    isPending,
    isError,
    error,
  } = useMutation(trpc.github.getUserGithubRepos.mutationOptions());

  return (
    <div>
      <div className="flex gap-4 mb-4">
        <Button
          disabled={isPending}
          onClick={() => fetch()}
          className="flex gap-2 items-center"
        >
          {isPending && <Loader2 className="animate-spin" />}
          <span>Fetch</span>
        </Button>
      </div>
      {isError && error && (
        <Toast
          id="repo-error"
          variant="error"
          title="Error"
          description={error.message}
        />
      )}
      {data?.repositories.map((repo) => (
        <div key={repo.id}>{repo.name}</div>
      ))}
    </div>
  );
};

export default Repositories;
