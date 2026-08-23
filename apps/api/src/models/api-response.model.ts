export const APIStatus = {
  Error: "error",
  Success: "success",
} as const;

export type APIStatus = (typeof APIStatus)[keyof typeof APIStatus];

export type APIResponse<DataType = unknown> = {
  status: APIStatus;
  statusCode: number;
  message: string;
  data: DataType;
};
