CREATE TYPE "public"."DeploymentStatus" AS ENUM('queued', 'cloning', 'installing', 'building', 'starting', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."GitProvider" AS ENUM('github', 'bitbucket');--> statement-breakpoint
CREATE TYPE "public"."state" AS ENUM('started', 'completed');--> statement-breakpoint
CREATE TYPE "public"."ProjectEnv" AS ENUM('preview', 'production');--> statement-breakpoint
CREATE TYPE "public"."resourceStatus" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TABLE "GithubAppInstallations" (
	"id" serial PRIMARY KEY NOT NULL,
	"installationId" bigint,
	"state" "state" DEFAULT 'started',
	"userId" text NOT NULL,
	"resourceStatus" "resourceStatus" DEFAULT 'active' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" text NOT NULL,
	"modifiedAt" timestamp with time zone DEFAULT now(),
	"modifiedBy" text
);
--> statement-breakpoint
CREATE TABLE "ProjectDomains" (
	"id" serial PRIMARY KEY NOT NULL,
	"projectId" bigint NOT NULL,
	"domain" text NOT NULL,
	"env" "ProjectEnv" NOT NULL,
	"userId" text NOT NULL,
	"resourceStatus" "resourceStatus" DEFAULT 'active' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" text NOT NULL,
	"modifiedAt" timestamp with time zone DEFAULT now(),
	"modifiedBy" text
);
--> statement-breakpoint
CREATE TABLE "Projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"gitProvider" "GitProvider" NOT NULL,
	"repoId" bigint NOT NULL,
	"userId" text NOT NULL,
	"resourceStatus" "resourceStatus" DEFAULT 'active' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" text NOT NULL,
	"modifiedAt" timestamp with time zone DEFAULT now(),
	"modifiedBy" text,
	CONSTRAINT "Projects_repoId_unique" UNIQUE("repoId")
);
--> statement-breakpoint
CREATE TABLE "DeploymentLogs" (
	"id" serial PRIMARY KEY NOT NULL,
	"deploymentId" bigint NOT NULL,
	"message" text NOT NULL,
	"resourceStatus" "resourceStatus" DEFAULT 'active' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" text NOT NULL,
	"modifiedAt" timestamp with time zone DEFAULT now(),
	"modifiedBy" text
);
--> statement-breakpoint
CREATE TABLE "Deployments" (
	"id" serial PRIMARY KEY NOT NULL,
	"projectId" bigint NOT NULL,
	"repoId" bigint NOT NULL,
	"branch" text NOT NULL,
	"commit" text NOT NULL,
	"status" "DeploymentStatus" DEFAULT 'queued' NOT NULL,
	"env" "ProjectEnv" NOT NULL,
	"userId" text NOT NULL,
	"resourceStatus" "resourceStatus" DEFAULT 'active' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" text NOT NULL,
	"modifiedAt" timestamp with time zone DEFAULT now(),
	"modifiedBy" text
);
--> statement-breakpoint
ALTER TABLE "ProjectDomains" ADD CONSTRAINT "ProjectDomains_projectId_Projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "DeploymentLogs" ADD CONSTRAINT "DeploymentLogs_deploymentId_Deployments_id_fk" FOREIGN KEY ("deploymentId") REFERENCES "public"."Deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Deployments" ADD CONSTRAINT "Deployments_projectId_Projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Projects_repoId_index" ON "Projects" USING btree ("repoId");