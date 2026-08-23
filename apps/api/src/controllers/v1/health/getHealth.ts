import { APIHandler } from "../../../models/api-handler.model.js";

const getHealth: APIHandler = async (req, res) => {
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "System is healthy.",
    data: "OK",
    errors: null,
  });
};

export default getHealth;
