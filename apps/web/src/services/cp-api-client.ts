import "server-only";
import { ControlPanelAPIClient } from "@repo/api-sdk/client";

const cpApiClient = new ControlPanelAPIClient();

export default cpApiClient;
