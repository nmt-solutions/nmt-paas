ALTER TABLE "GithubAppInstallations" ADD COLUMN "connectionStateHash" text;--> statement-breakpoint
ALTER TABLE "GithubAppInstallations" ADD COLUMN "connectionStateExpiresAt" timestamp with time zone;