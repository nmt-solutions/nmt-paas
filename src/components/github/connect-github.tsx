"use client";

import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useTRPC } from "@/trpc/client";
import toast from "../toast/toast";
import { Button } from "../ui/button";
import { useSearchParams } from "next/navigation";

const ConnectGithub = () => {
  const trpc = useTRPC();
  const { mutate: connectGithub, isPending } = useMutation(
    trpc.github.connectGithub.mutationOptions(),
  );

  const searchParams = useSearchParams();

  const handleConnect = () => {
    connectGithub(undefined, {
      onError: (err) => {
        toast({ title: "Error", description: err.message });
      },
      onSuccess: (res) => {
        toast({ title: "Connecting", description: res.message });
        if (res.redirect) {
          window.location.href = res.url;
        }
      },
    });
  };

  return (
    <Button
      disabled={isPending}
      className="flex gap-2 items-center justify-center"
      onClick={handleConnect}
    >
      {isPending && <Loader2 data-slot="icon" className="animate-spin" />}
      <span>Connect Github</span>
    </Button>
  );
};

export default ConnectGithub;
