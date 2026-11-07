import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { Deployments } from "./deployment";

export const DeploymentPublications = pgTable("DeploymentPublications", {
  deploymentId: bigint({ mode: "number" })
    .primaryKey()
    .references(() => Deployments.id),
  imageId: text().notNull(),
  imageName: text().notNull(),
  status: text({ enum: ["pending", "publishing", "published", "failed"] })
    .notNull()
    .default("pending"),
  lastError: text(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
