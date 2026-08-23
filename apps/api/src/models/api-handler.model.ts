import { APIResponse } from "@repo/api-sdk/models/api-response";
import { RequestHandler } from "express";

export type APIHandler<
  DataType = unknown,
  ErrorsType = unknown,
  Params = Record<string, string>,
  ReqBody = unknown,
  ReqQuery = Record<string, string>,
> = RequestHandler<
  Params,
  APIResponse<DataType, ErrorsType>,
  ReqBody,
  ReqQuery
>;
