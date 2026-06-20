import { eq, type InferSelectModel } from "drizzle-orm";
import { database } from "..";
import { GithubAppInstallations } from "../schema";
import type { UpdateInput } from "../utils/types";

export const getUserAppInstall = (userId: string) => {
  return database.query.GithubAppInstallations.findFirst({
    where: { userId, resourceStatus: "active" },
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
