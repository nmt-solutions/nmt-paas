import path from "path";

export const getRepoDir = (deploymentId: string) => {
  const REPOS_DIR = path.join(process.cwd(), "repos");

  const projectDir = path.join(REPOS_DIR, deploymentId);

  return projectDir;
};
