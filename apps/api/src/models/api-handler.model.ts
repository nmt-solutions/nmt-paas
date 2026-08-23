import { RequestHandler } from "express";
import { APIResponse } from "./api-response.model.js";

export type APIHandler<
  DataType = unknown,
  Params = Record<string, string>,
  ReqBody = unknown,
  ReqQuery = Record<string, string>,
> = RequestHandler<Params, APIResponse<DataType>, ReqBody, ReqQuery>;
