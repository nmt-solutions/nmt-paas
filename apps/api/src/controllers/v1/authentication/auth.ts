import env from "../../../env/vars.js";
import { APIHandler } from "../../../models/api-handler.model.js";

export const requireApiAuth: APIHandler = (req, res, next) => {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Unauthorized",
      data: null,
    });

    return;
  }

  const token = authorization.slice("Bearer ".length);

  if (token !== env.variables.API_KEY) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Unauthorized",
      data: null,
    });

    return;
  }

  next();
};
