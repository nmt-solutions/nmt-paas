import { pgEnum } from "drizzle-orm/pg-core";

export const ResourceStatus = pgEnum("resourceStatus", ["active", "inactive"]);

export const GitProvider = pgEnum("GitProvider", ["github", "bitbucket"]);

export const GithubAppInstallState = pgEnum("state", ["started", "completed"]);

export const AppEnv = pgEnum("AppEnv", ["preview", "production"]);

export const DeploymentStatus = pgEnum("DeploymentStatus", [
  "queued",
  "cloning",
  "installing",
  "building",
  "starting",
  "success",
  "failed",
]);
