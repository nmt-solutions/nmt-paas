import { pgTable, serial, bigint, text } from "drizzle-orm/pg-core";
import { Projects } from "./project";
import { AppEnv } from "../enums";
import { timestampDefault, ResourceStatus } from "../common";

export const EnvVars = pgTable("EnvVars", {
  id: serial("id").primaryKey(),
  projectId: bigint({ mode: "number" })
    .notNull()
    .references(() => Projects.id),
  key: text("key").notNull(),
  encryptedValue: text("encryptedValue").notNull(),
  env: AppEnv("env").notNull(),
  resourceStatus: ResourceStatus(),
  createdAt: timestampDefault("createdAt"),
  createdBy: text("createdBy").notNull(),
  modifiedAt: timestampDefault("modifiedAt", { frequent: true }),
  modifiedBy: text("modifiedBy"),
});
