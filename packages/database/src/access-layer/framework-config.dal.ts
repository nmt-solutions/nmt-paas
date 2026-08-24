import { eq, InferInsertModel } from "drizzle-orm";
import { database } from "..";
import { FrameworkConfig } from "../tables/framework-config";

export const createFrameworkConfig = async (
  params: InferInsertModel<typeof FrameworkConfig>,
) => {
  const [frameworkConfig] = await database
    .insert(FrameworkConfig)
    .values(params)
    .returning();

  return frameworkConfig;
};

export const updateFrameworkConfig = async (
  appId: number,
  updatedBy: string,
  params: Omit<
    Partial<InferInsertModel<typeof FrameworkConfig>>,
    "appId" | "createdBy"
  >,
) =>
  database
    .update(FrameworkConfig)
    .set({ ...params, modifiedBy: updatedBy })
    .where(eq(FrameworkConfig.appId, appId));
