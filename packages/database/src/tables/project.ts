import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { ResourceStatus, timestampDefault } from "../common";

export const Projects = pgTable("Projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  userId: text("userId").notNull(),
  resourceStatus: ResourceStatus(),
  createdAt: timestampDefault("createdAt"),
  createdBy: text("createdBy").notNull(),
  modifiedAt: timestampDefault("modifiedAt", { frequent: true }),
  modifiedBy: text("modifiedBy"),
});
