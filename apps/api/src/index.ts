import express from "express";
import env from "./env/vars.js";
import v1Router from "./router/v1/v1.router.js";

const app = express();

app.use(express.json());

app.use("/api/v1", v1Router);

app.listen(env.variables.API_APP_PORT, "0.0.0.0", (error) => {
  if (error) {
    console.error(error);
  } else {
    console.log(
      `[API Server]: Service Started on http://0.0.0.0:${env.variables.API_APP_PORT}`,
    );
  }
});
