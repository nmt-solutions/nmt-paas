import { and, eq, type InferSelectModel } from "drizzle-orm";
import { database } from "..";
import type { UpdateInput } from "../utils/types";
import { GithubAppInstallations } from "../schema";

export const getUserAppInstall = (userId: string) => {
  return database.query.GithubAppInstallations.findFirst({
    where: and(
      eq(GithubAppInstallations.userId, userId),
      eq(GithubAppInstallations.resourceStatus, "active"),
    ),
  });
};

export const createUserAppInstall = (userId: string) => {
  return database
    .insert(GithubAppInstallations)
    .values({ userId, createdBy: userId })
    .returning();
};

export const updateUserAppInstall = (
  params: UpdateInput<InferSelectModel<typeof GithubAppInstallations>, "id">,
  updatedBy: string,
) => {
  return database
    .update(GithubAppInstallations)
    .set({ ...params, modifiedBy: updatedBy, id: undefined })
    .where(eq(GithubAppInstallations.id, params.id));
};
