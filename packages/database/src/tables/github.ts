import { bigint, pgTable, serial, text } from "drizzle-orm/pg-core";
import { ResourceStatus, timestamp, timestampDefault } from "../common";
import { GithubAppInstallState } from "../enums";

export const GithubAppInstallations = pgTable("GithubAppInstallations", {
  id: serial("id").primaryKey(),
  installationId: bigint({ mode: "number" }),
  state: GithubAppInstallState("state").default("started"),
  connectionStateHash: text("connectionStateHash"),
  connectionStateExpiresAt: timestamp("connectionStateExpiresAt"),
  userId: text("userId").notNull(),
  resourceStatus: ResourceStatus(),
  createdAt: timestampDefault("createdAt"),
  createdBy: text("createdBy").notNull(),
  modifiedAt: timestampDefault("modifiedAt", { frequent: true }),
  modifiedBy: text("modifiedBy"),
});
