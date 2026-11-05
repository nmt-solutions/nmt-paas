import axios, { isAxiosError } from "axios";
import env from "./env/vars";
import { APIResponse } from "./models/api-response";
import { ValidationErrors } from "./models/deployment-queue";
import { tryCatch } from "./utils/try-catch";
import { AxiosHeaders } from "axios";
import {
  consumeRuntimeLogStream,
  type RuntimeLogEvent,
} from "./runtime-logs.js";

export type AdminHostResponse = {
  data: {
    health: string;
    cpuCount: number;
    memory: { total: number; used: number };
    docker: {
      containers: number;
      runningContainers: number;
      images: number;
      volumes: number;
    };
  };
};

export type DockerResourcesResponse = {
  data: { Id?: string; Name?: string; Names?: string[]; Repository?: string }[];
};

export class ControlPanelAPIClient {
  private baseUrl: string = env.variables.API_BASE_URL;
  private apiKey: string = env.variables.API_KEY;

  private getHeaders() {
    const headers = new AxiosHeaders();
    headers.set("Authorization", `Bearer ${this.apiKey}`);

    return headers;
  }

  async queueDeployment(
    deploymentId: number,
    userId: string,
  ): Promise<APIResponse<true, ValidationErrors>> {
    const { data: response, error } = await tryCatch(
      axios.post<APIResponse<true, ValidationErrors>>(
        `${this.baseUrl}/deployments/queue`,
        { deploymentId, userId },
        // Queueing must be quick. A bounded request prevents the UI from
        // remaining in a loading state forever when the control plane is down.
        { headers: this.getHeaders(), timeout: 15_000 },
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

  async streamRuntimeLogs(
    deploymentId: number,
    onLog: (log: string) => void,
    signal?: AbortSignal,
    onEvent?: (event: RuntimeLogEvent) => void,
  ) {
    const response = await fetch(
      `${this.baseUrl}/logs/stream/${deploymentId}`,
      {
        signal,
        headers: this.getHeaders(),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to stream deployment logs: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("Deployment log stream is not available.");
    }

    await consumeRuntimeLogStream(response.body, (event) => {
      if (event.type === "runtime" && event.deploymentId !== deploymentId) {
        throw new Error("Host returned a different runtime identity.");
      }
      if (event.type === "log") onLog(event.text);
      if (onEvent) onEvent(event);
      else if (event.type === "error") throw new Error(event.message);
    });
  }

  async getAdminHost(): Promise<AdminHostResponse> {
    const response = await axios.get(`${this.baseUrl}/admin/host`, {
      headers: this.getHeaders(),
    });
    return response.data as AdminHostResponse;
  }

  async getDockerResources(
    resource: "containers" | "images" | "volumes",
  ): Promise<DockerResourcesResponse> {
    const response = await axios.get(
      `${this.baseUrl}/admin/docker/${resource}`,
      { headers: this.getHeaders() },
    );
    return response.data as DockerResourcesResponse;
  }

  async deleteDockerResource(
    resource: "containers" | "images" | "volumes",
    id: string,
  ) {
    const response = await axios.delete(
      `${this.baseUrl}/admin/docker/${resource}/${encodeURIComponent(id)}`,
      { headers: this.getHeaders() },
    );
    return response.data;
  }
}
