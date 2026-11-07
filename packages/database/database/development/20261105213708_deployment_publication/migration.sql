CREATE TABLE "DeploymentPublications" (
	"deploymentId" bigint PRIMARY KEY,
	"imageId" text NOT NULL,
	"imageName" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"lastError" text,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "DeploymentPublications" ADD CONSTRAINT "DeploymentPublications_deploymentId_Deployments_id_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployments"("id");