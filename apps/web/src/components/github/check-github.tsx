"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";
import { Toast } from "../toast/toast";
import { Button } from "../ui/button";

const CheckGithub = () => {
  const [enabled, setEnabled] = useState(false);

  const trpc = useTRPC();

  const queryOptions = trpc.github.getGithubAppForUser.queryOptions();

  const { data, isFetching, isError, error } = useQuery({
    ...queryOptions,
    enabled,
  });

  const queryClient = useQueryClient();

  const checkConnection = () => {
    if (enabled) {
      queryClient.invalidateQueries({ queryKey: queryOptions.queryKey });
    } else {
      setEnabled(true);
    }
  };

  return (
    <>
      <Button
        disabled={isFetching}
        onClick={() => checkConnection()}
        className="flex gap-2 items-center"
      >
        {isFetching && <Loader2 className="animate-spin" />}
        <span>Check Github Connection</span>
      </Button>

      {data && <p>{data.appName}</p>}

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
