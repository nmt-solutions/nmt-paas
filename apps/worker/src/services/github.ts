import { App } from "octokit";
import { database } from "@repo/database";
import env from "../env/vars.js";
import { tryCatch } from "../utils/try-catch.js";
import { registerDiagnosticSecrets } from "./diagnostics.js";

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
    throw new Error(
      "GitHub installation not found. Connect the GitHub App and grant repository access.",
    );
  }

  if (!appInstall.installationId) {
    throw new Error(
      "GitHub installation not found. Connect the GitHub App and grant repository access.",
    );
  }

  return appInstall.installationId;
}

export const getUserOctokitToken = async (userId: string) => {
  const installationId = await getUserGithubAppInstallationId(userId);

  const { data: octokit, error } = await tryCatch(
    app.getInstallationOctokit(installationId),
  );

  if (error) {
    throw new Error(
      "GitHub installation unavailable. Reconnect the GitHub App and check repository access.",
    );
  }

  const { data: installation, error: installationError } = await tryCatch(
    octokit.request("GET /app/installations/{installation_id}", {
      installation_id: installationId,
    }),
  );

  if (installationError) {
    throw new Error(
      "GitHub installation unavailable. Reconnect the GitHub App and check repository access.",
    );
  }

  const { token } = (await octokit.auth({
    type: "installation",
  })) as { token: string };

  return {
    token,
    owner: (installation.data.account as { login: string }).login,
    octokit,
  };
};

export const getCloneUrl = async (userId: string, repositoryId: number) => {
  const { token: octokitToken, octokit } = await getUserOctokitToken(userId);
  registerDiagnosticSecrets(octokitToken);

  const { data: repository, error } = await tryCatch(
    octokit.request("GET /repositories/{repository_id}", {
      repository_id: repositoryId,
    }),
  );
  if (error || !repository.data.clone_url) {
    throw new Error(
      `Unable to access GitHub repository ${repositoryId} with the connected installation. Check repository access.`,
    );
  }
  const cloneUrl = new URL(repository.data.clone_url);
  cloneUrl.username = "x-access-token";
  cloneUrl.password = octokitToken;

  return cloneUrl.href;
};
