import { pgTable, serial, text, bigint } from "drizzle-orm/pg-core";
import { timestampDefault } from "../common";
import { GitProvider, ProjectEnv, ResourceStatus } from "../enums";
import { index } from "drizzle-orm/pg-core";

export const Projects = pgTable(
  "Projects",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    gitProvider: GitProvider("gitProvider").notNull(),
    repoId: bigint({ mode: "number" }).unique().notNull(),
    userId: text("userId").notNull(),
    resourceStatus: ResourceStatus("resourceStatus")
      .notNull()
      .default("active"),
    createdAt: timestampDefault("createdAt"),
    createdBy: text("createdBy").notNull(),
    modifiedAt: timestampDefault("modifiedAt", { frequent: true }),
    modifiedBy: text("modifiedBy"),
  },
  (table) => [index("Projects_repoId_index").on(table.repoId)],
);

export const ProjectDomains = pgTable("ProjectDomains", {
  id: serial("id").primaryKey(),
  projectId: bigint({ mode: "number" })
    .notNull()
    .references(() => Projects.id),
  domain: text("domain").notNull(),
  env: ProjectEnv("env").notNull(),
  userId: text("userId").notNull(),
  resourceStatus: ResourceStatus("resourceStatus").notNull().default("active"),
  createdAt: timestampDefault("createdAt"),
  createdBy: text("createdBy").notNull(),
  modifiedAt: timestampDefault("modifiedAt", { frequent: true }),
  modifiedBy: text("modifiedBy"),
});
