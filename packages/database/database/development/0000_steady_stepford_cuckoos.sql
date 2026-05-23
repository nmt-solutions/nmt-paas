CREATE TYPE "public"."state" AS ENUM('started', 'completed');--> statement-breakpoint
CREATE TYPE "public"."resourceStatus" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TABLE "GithubAppInstallations" (
	"id" serial PRIMARY KEY NOT NULL,
	"installationId" text,
	"state" "state" DEFAULT 'started',
	"userId" text NOT NULL,
	"resourceStatus" "resourceStatus" DEFAULT 'active' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" text NOT NULL,
	"modifiedAt" timestamp with time zone DEFAULT now(),
	"modifiedBy" text
);
