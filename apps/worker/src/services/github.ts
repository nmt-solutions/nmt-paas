import { App } from "octokit";
import { database } from "@repo/database";
import env from "../env/vars.js";
import { tryCatch } from "../utils/try-catch.js";

const app = new App({
  appId: env.variables.GITHUB_APP_ID,
  privateKey: env.variables.GITHUB_APP_PRIVATE_KEY,
});

export const getUserAppInstall = (userId: string) => {
  return database.query.GithubAppInstallations.findFirst({
    where: { userId, resourceStatus: "active" },
  });
};

export async function getUserGithubAppInstallationId(userId: string) {
  const { data: appInstall, error: appInstallError } = await tryCatch(
    getUserAppInstall(userId),
  );

  if (appInstallError) {
    throw new Error("Unable to get app installation");
  }

  if (!appInstall) {
    throw new Error("App Installation Not Found");
  }

  if (!appInstall.installationId) {
    throw new Error("App Installation Id Not Found");
  }

  return appInstall.installationId;
}

export const getUserOctokitToken = async (userId: string) => {
  const installationId = await getUserGithubAppInstallationId(userId);

  const { data: octokit, error } = await tryCatch(
    app.getInstallationOctokit(installationId),
  );

  if (error) {
    throw new Error("Invalid installationId");
  }

  const { token } = (await octokit.auth({
    type: "installation",
  })) as { token: string };

  return token;
};
