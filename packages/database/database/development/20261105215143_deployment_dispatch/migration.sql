CREATE TABLE "DeploymentDispatches" (
	"deploymentId" bigint PRIMARY KEY,
	"userId" text NOT NULL,
	"submissionId" uuid NOT NULL,
	"requestHash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"nextAttemptAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lease" uuid,
	"leaseUntil" timestamp with time zone,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "DeploymentDispatches_owner_submission" UNIQUE("userId","submissionId"),
	CONSTRAINT "DeploymentDispatches_state" CHECK ("state" IN ('pending', 'dispatched', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX "DeploymentDispatches_pending_due" ON "DeploymentDispatches" ("nextAttemptAt") WHERE "state" = 'pending';--> statement-breakpoint
ALTER TABLE "DeploymentDispatches" ADD CONSTRAINT "DeploymentDispatches_deploymentId_Deployments_id_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployments"("id");