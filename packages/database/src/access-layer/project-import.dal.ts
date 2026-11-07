import { database } from "..";
import {
  Apps,
  Deployments,
  EnvVars,
  FrameworkConfig,
  Projects,
} from "../schema";
import { createAppDomains } from "./app-domains.dal";
import {
  lockDeploymentSubmission,
  recordDeploymentDispatch,
  type Submission,
} from "./deployment-dispatch.dal";

/** Commit the related local setup together; callers resolve GitHub before this
 * operation and contact the deployment host only after it commits. */
export const createProjectImport = (params: {
  userId: string;
  repoId: number;
  projectName: string;
  appName: string;
  branch: string;
  commit: string;
  frameworkConfig: {
    framework: string;
    rootDirectory: string;
    installCommand: string;
    buildCommand: string;
    startCommand: string;
    outputDirectory: string;
    port: number;
  };
  envVars: { key: string; encryptedValue: string }[];
  submission: Submission;
}) =>
  database.transaction(async (tx) => {
    const existing = await lockDeploymentSubmission(tx, params.submission);
    if (existing) return existing;
    const { userId, repoId } = params;
    const [project] = await tx
      .insert(Projects)
      .values({ name: params.projectName, userId, createdBy: userId })
      .returning();
    if (!project) throw new Error("Project creation failed");

    const [app] = await tx
      .insert(Apps)
      .values({
        repoId,
        projectId: project.id,
        appName: params.appName,
        gitProvider: "github",
        createdBy: userId,
      })
      .returning();
    if (!app) throw new Error("App creation failed");

    const domains = await createAppDomains(app.id, app.appName, userId, tx);
    if (domains.length !== 2) throw new Error("Domain creation failed");

    const [framework] = await tx
      .insert(FrameworkConfig)
      .values({ ...params.frameworkConfig, appId: app.id, createdBy: userId })
      .returning();
    if (!framework) throw new Error("Framework configuration creation failed");

    if (params.envVars.length) {
      const saved = await tx
        .insert(EnvVars)
        .values(
          params.envVars.map((value) => ({
            ...value,
            projectId: project.id,
            env: "production" as const,
            createdBy: userId,
          })),
        )
        .returning();
      if (saved.length !== params.envVars.length)
        throw new Error("Environment configuration creation failed");
    }

    const [deployment] = await tx
      .insert(Deployments)
      .values({
        appId: app.id,
        repoId,
        userId,
        createdBy: userId,
        branch: params.branch,
        commit: params.commit,
        env: "production",
      })
      .returning();
    if (!deployment) throw new Error("Deployment creation failed");

    await recordDeploymentDispatch(tx, params.submission, deployment.id);

    return { project, app, deployment };
  });
