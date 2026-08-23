import axios, { isAxiosError } from "axios";
import env from "./env/vars";
import { APIResponse } from "./models/api-response";
import { ValidationErrors } from "./models/deployment-queue";
import { tryCatch } from "./utils/try-catch";

export class ControlPanelAPIClient {
  private baseUrl: string = env.variables.API_BASE_URL;
  private apiKey: string = env.variables.API_KEY;

  async queueDeployment(
    deploymentId: number,
    userId: string,
  ): Promise<APIResponse<true, ValidationErrors>> {
    const { data: response, error } = await tryCatch(
      axios.post<APIResponse<true, ValidationErrors>>(
        `${this.baseUrl}/deployment/queue`,
        { deploymentId, userId },
      ),
    );

    if (error) {
      if (isAxiosError(error) && error.response && error.response.data) {
        return error.response.data;
      }

      return {
        status: "error",
        statusCode: 500,
        message: `ControlPanelAPIClientError: ${error.message}`,
        data: null,
        errors: { fieldErrors: {}, formErrors: [] },
      };
    }

    return response.data;
  }
}
