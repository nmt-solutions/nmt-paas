import { pgTable, serial, text, bigint, integer } from "drizzle-orm/pg-core";
import { ResourceStatus, timestampDefault } from "../common";

export const FrameworkConfig = pgTable("FrameworkConfig", {
  id: serial("id").primaryKey(),
  appId: bigint({ mode: "number" }),
  framework: text("framework").notNull(),
  rootDirectory: text("rootDirectory").notNull(),
  installCommand: text("installCommand").notNull(),
  buildCommand: text("buildCommand").notNull(),
  startCommand: text("startCommand").notNull(),
  outputDirectory: text("outputDirectory").notNull(),
  port: integer("port").notNull(),
  resourceStatus: ResourceStatus(),
  createdAt: timestampDefault("createdAt"),
  createdBy: text("createdBy").notNull(),
  modifiedAt: timestampDefault("modifiedAt", { frequent: true }),
  modifiedBy: text("modifiedBy"),
});
