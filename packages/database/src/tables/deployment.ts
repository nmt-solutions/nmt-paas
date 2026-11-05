import { pgTable, serial, text, bigint, jsonb } from "drizzle-orm/pg-core";
import { DeploymentStatus, AppEnv } from "../enums";
import { ResourceStatus, timestampDefault } from "../common";
import { Apps } from "./apps";

export type DeploymentCleanupArtifact = {
  id: string;
  kind: "builder" | "runtime" | "image" | "prior runtime";
  // Labels captured when ownership was established; removal always uses the ID.
  labels: Record<string, string>;
  replacementId?: string;
  status: "pending" | "failed" | "complete" | "preserved";
  error?: string;
};

export type DeploymentCleanup = {
  status: "pending" | "complete";
  artifacts: DeploymentCleanupArtifact[];
};

export const Deployments = pgTable("Deployments", {
  id: serial("id").primaryKey(),
  appId: bigint({ mode: "number" })
    .notNull()
    .references(() => Apps.id),
  repoId: bigint({ mode: "number" }).notNull(),
  branch: text("branch").notNull(),
  commit: text("commit").notNull(),
  status: DeploymentStatus("status").notNull().default("queued"),
  cleanup: jsonb("cleanup").$type<DeploymentCleanup>(),
  env: AppEnv("env").notNull(),
  userId: text("userId").notNull(),
  resourceStatus: ResourceStatus(),
  createdAt: timestampDefault("createdAt"),
  createdBy: text("createdBy").notNull(),
  modifiedAt: timestampDefault("modifiedAt", { frequent: true }),
  modifiedBy: text("modifiedBy"),
});

export const DeploymentLogs = pgTable("DeploymentLogs", {
  id: serial("id").primaryKey(),
  deploymentId: bigint({ mode: "number" })
    .notNull()
    .references(() => Deployments.id),
  message: text("message").notNull(),
  resourceStatus: ResourceStatus(),
  createdAt: timestampDefault("createdAt"),
  createdBy: text("createdBy").notNull(),
  modifiedAt: timestampDefault("modifiedAt", { frequent: true }),
  modifiedBy: text("modifiedBy"),
});
