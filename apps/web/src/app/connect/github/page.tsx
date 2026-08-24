"use client";

import toast from "@/components/toast/toast";
import { useTRPC } from "@/trpc/client";
import { useMutation } from "@tanstack/react-query";
import { GitBranch, Loader2 } from "lucide-react";
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
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="glass-panel w-full max-w-md p-8 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
          <GitBranch className="size-6" />
        </div>
        {error ? (
          <div className="mt-5">
            <h1 className="text-xl font-semibold">GitHub connection failed</h1>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          </div>
        ) : (
          <div className="mt-5">
            <Loader2 className="mx-auto size-5 animate-spin text-primary" />
            <h1 className="mt-4 text-xl font-semibold">Connecting GitHub</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              We’re verifying your installation and bringing you back to the
              dashboard.
            </p>
          </div>
        )}
      </div>
    </main>
  );
};

export default ConnectGithub;
