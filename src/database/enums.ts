import { pgEnum } from "drizzle-orm/pg-core";

export const ResourceStatus = pgEnum("resourceStatus", ["active", "inactive"]);

export const GithubAppInstallState = pgEnum("state", ["started", "completed"]);
