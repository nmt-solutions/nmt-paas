CREATE TYPE "AppEnv" AS ENUM('preview', 'production');--> statement-breakpoint
CREATE TYPE "DeploymentStatus" AS ENUM('queued', 'cloning', 'installing', 'building', 'starting', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "GitProvider" AS ENUM('github', 'bitbucket');--> statement-breakpoint
CREATE TYPE "state" AS ENUM('started', 'completed');--> statement-breakpoint
CREATE TYPE "resourceStatus" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TABLE "GithubAppInstallations" (
	"id" serial PRIMARY KEY,
	"installationId" bigint,
	"state" "state" DEFAULT 'started'::"state",
	"userId" text NOT NULL,
	"resourceStatus" "resourceStatus" DEFAULT 'active'::"resourceStatus" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" text NOT NULL,
	"modifiedAt" timestamp with time zone DEFAULT now(),
	"modifiedBy" text
);
--> statement-breakpoint
CREATE TABLE "Projects" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL,
	"userId" text NOT NULL,
	"resourceStatus" "resourceStatus" DEFAULT 'active'::"resourceStatus" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" text NOT NULL,
	"modifiedAt" timestamp with time zone DEFAULT now(),
	"modifiedBy" text
);
--> statement-breakpoint
CREATE TABLE "AppDomains" (
	"id" serial PRIMARY KEY,
	"appId" bigint NOT NULL,
	"domain" text NOT NULL CONSTRAINT "unique_app_domain" UNIQUE,
	"env" "AppEnv" NOT NULL,
	"userId" text NOT NULL,
	"resourceStatus" "resourceStatus" DEFAULT 'active'::"resourceStatus" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" text NOT NULL,
	"modifiedAt" timestamp with time zone DEFAULT now(),
	"modifiedBy" text
);
--> statement-breakpoint
CREATE TABLE "Apps" (
	"id" serial PRIMARY KEY,
	"appName" text NOT NULL,
	"projectId" bigint NOT NULL,
	"gitProvider" "GitProvider" NOT NULL,
	"repoId" bigint NOT NULL,
	"resourceStatus" "resourceStatus" DEFAULT 'active'::"resourceStatus" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" text NOT NULL,
	"modifiedAt" timestamp with time zone DEFAULT now(),
	"modifiedBy" text
);
--> statement-breakpoint
CREATE TABLE "DeploymentLogs" (
	"id" serial PRIMARY KEY,
	"deploymentId" bigint NOT NULL,
	"message" text NOT NULL,
	"resourceStatus" "resourceStatus" DEFAULT 'active'::"resourceStatus" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" text NOT NULL,
	"modifiedAt" timestamp with time zone DEFAULT now(),
	"modifiedBy" text
);
--> statement-breakpoint
CREATE TABLE "Deployments" (
	"id" serial PRIMARY KEY,
	"appId" bigint NOT NULL,
	"repoId" bigint NOT NULL,
	"branch" text NOT NULL,
	"commit" text NOT NULL,
	"status" "DeploymentStatus" DEFAULT 'queued'::"DeploymentStatus" NOT NULL,
	"env" "AppEnv" NOT NULL,
	"userId" text NOT NULL,
	"resourceStatus" "resourceStatus" DEFAULT 'active'::"resourceStatus" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" text NOT NULL,
	"modifiedAt" timestamp with time zone DEFAULT now(),
	"modifiedBy" text
);
--> statement-breakpoint
CREATE TABLE "EnvVars" (
	"id" serial PRIMARY KEY,
	"projectId" bigint NOT NULL,
	"key" text NOT NULL,
	"encryptedValue" text NOT NULL,
	"env" "AppEnv" NOT NULL,
	"resourceStatus" "resourceStatus" DEFAULT 'active'::"resourceStatus" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" text NOT NULL,
	"modifiedAt" timestamp with time zone DEFAULT now(),
	"modifiedBy" text
);
--> statement-breakpoint
CREATE TABLE "FrameworkConfig" (
	"id" serial PRIMARY KEY,
	"appId" bigint,
	"framework" text NOT NULL,
	"rootDirectory" text NOT NULL,
	"installCommand" text NOT NULL,
	"buildCommand" text NOT NULL,
	"startCommand" text NOT NULL,
	"outputDirectory" text NOT NULL,
	"port" integer NOT NULL,
	"resourceStatus" "resourceStatus" DEFAULT 'active'::"resourceStatus" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" text NOT NULL,
	"modifiedAt" timestamp with time zone DEFAULT now(),
	"modifiedBy" text
);
--> statement-breakpoint
ALTER TABLE "AppDomains" ADD CONSTRAINT "AppDomains_appId_Apps_id_fkey" FOREIGN KEY ("appId") REFERENCES "Apps"("id");--> statement-breakpoint
ALTER TABLE "Apps" ADD CONSTRAINT "Apps_projectId_Projects_id_fkey" FOREIGN KEY ("projectId") REFERENCES "Projects"("id");--> statement-breakpoint
ALTER TABLE "DeploymentLogs" ADD CONSTRAINT "DeploymentLogs_deploymentId_Deployments_id_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployments"("id");--> statement-breakpoint
ALTER TABLE "Deployments" ADD CONSTRAINT "Deployments_appId_Apps_id_fkey" FOREIGN KEY ("appId") REFERENCES "Apps"("id");--> statement-breakpoint
ALTER TABLE "EnvVars" ADD CONSTRAINT "EnvVars_projectId_Projects_id_fkey" FOREIGN KEY ("projectId") REFERENCES "Projects"("id");