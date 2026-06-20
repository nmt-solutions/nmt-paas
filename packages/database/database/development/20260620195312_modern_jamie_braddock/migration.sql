CREATE TABLE "FrameworkConfig" (
	"id" serial PRIMARY KEY,
	"appId" bigint,
	"framework" text NOT NULL,
	"rootDirectory" text NOT NULL,
	"installCommand" text NOT NULL,
	"buildCommand" text NOT NULL,
	"startCommand" text NOT NULL,
	"outputDirectory" text NOT NULL,
	"resourceStatus" "resourceStatus" DEFAULT 'active'::"resourceStatus" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" text NOT NULL,
	"modifiedAt" timestamp with time zone DEFAULT now(),
	"modifiedBy" text
);
--> statement-breakpoint
ALTER TABLE "Apps" DROP CONSTRAINT "Apps_repoId_key";