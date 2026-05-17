"use client";

import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useTRPC } from "@/trpc/client";
import { Button } from "../ui/button";
import { Toast } from "../toast/toast";

const CheckGithub = () => {
  const trpc = useTRPC();

  const {
    data,
    isPending,
    mutate: getApp,
    isError,
    error,
  } = useMutation(trpc.github.getGithubAppForUser.mutationOptions());

  return (
    <>
      <Button
        disabled={isPending}
        onClick={() => getApp()}
        className="flex gap-2 items-center"
      >
        {isPending && <Loader2 className="animate-spin" />}
        <span>Check Github Connection</span>
      </Button>
      {data && <pre>{JSON.stringify(data, null, 2)}</pre>}
      {isError && error && (
        <Toast
          id="github-connection-error"
          variant="error"
          title="Error"
          description={error.message}
        />
      )}
    </>
  );
};

export default CheckGithub;
