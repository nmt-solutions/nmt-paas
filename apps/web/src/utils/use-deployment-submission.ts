"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";
import toast from "@/components/toast/toast";
import {
  clearDeploymentSubmissionId,
  getDeploymentSubmissionId,
} from "./deployment-submission";

// Both admission screens share lookup, identity lifetime and safe presentation.
// Mutation inputs and navigation stay with the screen that owns them.
export function useDeploymentSubmission(scope: string, acceptedTitle: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [isResolving, setIsResolving] = useState(false);
  const unconfirmed = () =>
    toast({
      title: "Could not confirm submission",
      description:
        "Its outcome is unknown. Retry to check the same submission; your retry will keep its identity.",
      variant: "warning",
    });
  const resolve = async () => {
    const submissionId = getDeploymentSubmissionId(scope);
    setIsResolving(true);
    try {
      const result = await queryClient.fetchQuery({
        ...trpc.deployment.submission.queryOptions({ submissionId }),
        staleTime: 0,
      });
      return { submissionId, result };
    } catch {
      unconfirmed();
      return undefined;
    } finally {
      setIsResolving(false);
    }
  };
  const present = (result: {
    outcome: "accepted" | "uncertain" | "rejected";
    message: string;
  }) => {
    if (result.outcome !== "uncertain") clearDeploymentSubmissionId(scope);
    toast({
      title:
        result.outcome === "accepted"
          ? acceptedTitle
          : result.outcome === "rejected"
            ? "Dispatch rejected"
            : "Deployment saved; confirmation pending",
      description: result.message,
      variant: result.outcome === "accepted" ? "success" : "warning",
    });
  };
  return { resolve, present, unconfirmed, isResolving };
}
