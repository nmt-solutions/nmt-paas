import axios, { isAxiosError } from "axios";
import env from "./env/vars";
import { APIResponse } from "./models/api-response";
import { ValidationErrors } from "./models/deployment-queue";
import { tryCatch } from "./utils/try-catch";
import { AxiosHeaders } from "axios";

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
        { headers: this.getHeaders() },
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

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, {
        stream: true,
      });

      const events = buffer.split("\n\n");

      buffer = events.pop() ?? "";

      for (const event of events) {
        const dataLine = event
          .split("\n")
          .find((line) => line.startsWith("data:"));

        if (!dataLine) {
          continue;
        }

        const data = dataLine.slice("data:".length).trim();

        if (!data) {
          continue;
        }

        try {
          onLog(JSON.parse(data));
        } catch {
          onLog(data);
        }
      }
    }
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
