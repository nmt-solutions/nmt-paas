import { database } from "..";
import env from "../env/vars";
import { AppDomains } from "../schema";
import { generateReadableRandomText } from "../utils/readable-random-text";

export const getAppDomains = async (appId: number) => {
  return await database.query.AppDomains.findMany({
    where: { appId: appId },
  });
};

export const createAppDomains = async (
  appId: number,
  appName: string,
  userId: string,
) => {
  let newDomainNames = {
    production: `${appName}.${env.variables.BASE_DOMAIN}`,
    preview: `${appName}-preview.${env.variables.BASE_DOMAIN}`,
  };

  while (true) {
    const existingAppDomains = await database.query.AppDomains.findFirst({
      where: {
        domain: { OR: [newDomainNames.production, newDomainNames.preview] },
      },
    });

    if (!existingAppDomains) {
      const appDomains = await database
        .insert(AppDomains)
        .values([
          {
            appId,
            domain: newDomainNames.production,
            env: "production",
            userId: userId,
            createdBy: userId,
          },
          {
            appId,
            domain: newDomainNames.preview,
            env: "preview",
            userId: userId,
            createdBy: userId,
          },
        ])
        .returning();

      return appDomains;
    }

    newDomainNames = generateDomainNames(appName);
  }
};

const generateDomainNames = (appName: string) => {
  const randomPart = generateReadableRandomText();

  return {
    production: `${appName}-${randomPart}.${env.variables.BASE_DOMAIN}`,
    preview: `${appName}-${randomPart}-preview.${env.variables.BASE_DOMAIN}`,
  };
};
