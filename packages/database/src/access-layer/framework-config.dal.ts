import { InferInsertModel } from "drizzle-orm";
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
