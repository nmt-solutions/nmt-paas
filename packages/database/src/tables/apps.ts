import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { timestampDefault, ResourceStatus } from "../common";
import { GitProvider, AppEnv } from "../enums";
import { bigint } from "drizzle-orm/pg-core";
import { Projects } from "./project";

export const Apps = pgTable("Apps", {
  id: serial("id").primaryKey(),
  appName: text("appName").notNull(),
  projectId: bigint({ mode: "number" })
    .notNull()
    .references(() => Projects.id),
  gitProvider: GitProvider("gitProvider").notNull(),
  repoId: bigint({ mode: "number" }).notNull(),
  resourceStatus: ResourceStatus(),
  createdAt: timestampDefault("createdAt"),
  createdBy: text("createdBy").notNull(),
  modifiedAt: timestampDefault("modifiedAt", { frequent: true }),
  modifiedBy: text("modifiedBy"),
});

export const AppDomains = pgTable("AppDomains", {
  id: serial("id").primaryKey(),
  appId: bigint({ mode: "number" })
    .notNull()
    .references(() => Apps.id),
  domain: text("domain").notNull(),
  env: AppEnv("env").notNull(),
  userId: text("userId").notNull(),
  resourceStatus: ResourceStatus(),
  createdAt: timestampDefault("createdAt"),
  createdBy: text("createdBy").notNull(),
  modifiedAt: timestampDefault("modifiedAt", { frequent: true }),
  modifiedBy: text("modifiedBy"),
});
