import { execa } from "execa";
import { getUserOctokitToken } from "../services/github.js";

export async function cloneRepo(userId: string, repo: string, dir: string) {
  const octakitToken = await getUserOctokitToken(userId);

  const cloneUrl = `https://x-access-token:${octakitToken}@github.com/${repo}.git`;

  await execa("git", ["clone", cloneUrl, dir], {
    stdio: "inherit",
  });
}
