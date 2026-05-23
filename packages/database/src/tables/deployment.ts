import { pgTable, serial, text, bigint } from "drizzle-orm/pg-core";
import { ResourceStatus, DeploymentStatus, ProjectEnv } from "../enums";
import { timestampDefault } from "../common";
import { Projects } from "./project";

export const Deployments = pgTable("Deployments", {
  id: serial("id").primaryKey(),
  projectId: bigint({ mode: "number" })
    .notNull()
    .references(() => Projects.id),
  repoId: bigint({ mode: "number" }).notNull(),
  branch: text("branch").notNull(),
  commit: text("commit").notNull(),
  status: DeploymentStatus("status").notNull().default("queued"),
  env: ProjectEnv("env").notNull(),
  userId: text("userId").notNull(),
  resourceStatus: ResourceStatus("resourceStatus").notNull().default("active"),
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
  resourceStatus: ResourceStatus("resourceStatus").notNull().default("active"),
  createdAt: timestampDefault("createdAt"),
  createdBy: text("createdBy").notNull(),
  modifiedAt: timestampDefault("modifiedAt", { frequent: true }),
  modifiedBy: text("modifiedBy"),
});
