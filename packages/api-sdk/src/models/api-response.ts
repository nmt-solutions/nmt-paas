export const APIStatus = {
  Error: "error",
  Success: "success",
} as const;

export type APIStatus = (typeof APIStatus)[keyof typeof APIStatus];

export type APIResponse<DataType = null, ErrorsType = null> =
  | {
      status: APIStatus;
      statusCode: number;
      message: string;
      data: DataType;
      errors: null;
    }
  | {
      status: APIStatus;
      statusCode: number;
      message: string;
      data: null;
      errors: ErrorsType;
    };
