"use client";

import toast from "@/components/toast/toast";
import { useTRPC } from "@/trpc/client";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";

const ConnectGithub = ({
  searchParams,
}: {
  searchParams: Promise<{ installation_id?: string; state?: string }>;
}) => {
  const [error, setError] = useState<string | null>(null);
  const params = use(searchParams);
  const trpc = useTRPC();
  const { mutate } = useMutation(
    trpc.github.verifyGithubInstall.mutationOptions(),
  );

  const router = useRouter();

  const installationId = params.installation_id;
  const state = params.state;

  useEffect(() => {
    if (installationId && state) {
      mutate(
        { installationId, state },
        {
          onError: (err) => {
            toast({
              title: "Github App Installation Error",
              description: err.message,
            });
            setError(err.message);
          },
          onSuccess: (res) => {
            toast({ title: "Success", description: res.message });
            router.replace("/dashboard");
          },
        },
      );
    } else {
      setError("Invalid Data From Github.");
    }
  }, [installationId, state, mutate, router]);

  return (
    <div>
      {error ? (
        <div>
          Error: <span className="text-rose-600">{error}</span>
        </div>
      ) : (
        <div className="flex items-center justify-around gap-2">
          <Loader2 className="animate-spin" />
          <span>Connecting Github Account...</span>
        </div>
      )}
    </div>
  );
};

export default ConnectGithub;
