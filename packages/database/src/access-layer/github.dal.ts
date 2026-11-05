import { and, desc, eq, gt, sql } from "drizzle-orm";
import { database } from "..";
import { GithubAppInstallations } from "../schema";

export const getUserAppInstall = (userId: string) => {
  return database.query.GithubAppInstallations.findFirst({
    where: { userId, resourceStatus: "active" },
    orderBy: { id: "desc" },
  });
};

export const startUserGithubConnection = (
  userId: string,
  connectionStateHash: string,
  connectionStateExpiresAt: Date,
) =>
  database.transaction(async (tx) => {
    // Serialize first-time connects as well as rotations without holding a
    // transaction open during GitHub requests.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
    const [existing] = await tx
      .select({ id: GithubAppInstallations.id })
      .from(GithubAppInstallations)
      .where(
        and(
          eq(GithubAppInstallations.userId, userId),
          eq(GithubAppInstallations.resourceStatus, "active"),
        ),
      )
      .orderBy(desc(GithubAppInstallations.id))
      .limit(1);
    const pending = {
      connectionStateHash,
      connectionStateExpiresAt,
      state: "started" as const,
    };
    if (existing) {
      await tx
        .update(GithubAppInstallations)
        .set({ ...pending, modifiedBy: userId })
        .where(
          and(
            eq(GithubAppInstallations.id, existing.id),
            eq(GithubAppInstallations.userId, userId),
          ),
        );
    } else {
      await tx
        .insert(GithubAppInstallations)
        .values({ ...pending, userId, createdBy: userId });
    }
  });

export const getPendingUserGithubConnection = (
  userId: string,
  connectionStateHash: string,
) =>
  database.query.GithubAppInstallations.findFirst({
    where: {
      userId,
      resourceStatus: "active",
      state: "started",
      connectionStateHash,
      connectionStateExpiresAt: { gt: new Date() },
    },
  });

export const completeUserGithubConnection = (
  userId: string,
  connectionStateHash: string,
  installationId: number,
) => {
  return database
    .update(GithubAppInstallations)
    .set({
      installationId,
      state: "completed",
      connectionStateHash: null,
      connectionStateExpiresAt: null,
      modifiedBy: userId,
    })
    .where(
      and(
        eq(GithubAppInstallations.userId, userId),
        eq(GithubAppInstallations.resourceStatus, "active"),
        eq(GithubAppInstallations.state, "started"),
        eq(GithubAppInstallations.connectionStateHash, connectionStateHash),
        gt(GithubAppInstallations.connectionStateExpiresAt, new Date()),
      ),
    )
    .returning({ id: GithubAppInstallations.id });
};
