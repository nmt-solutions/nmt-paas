import { Router } from "express";
import Docker from "dockerode";
import os from "node:os";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const adminRouter = Router();

adminRouter.get("/host", async (_req, res) => {
  try {
    const [info, containers, images, volumes, usage] = await Promise.all([
      docker.info(),
      docker.listContainers({ all: true }),
      docker.listImages(),
      docker.listVolumes(),
      docker.df(),
    ]);
    const totalMemory = os.totalmem();
    res.send({
      status: "success",
      statusCode: 200,
      message: "Host status",
      data: {
        health: "healthy",
        cpuCount: os.cpus().length,
        memory: { total: totalMemory, used: totalMemory - os.freemem() },
        docker: {
          containers: containers.length,
          runningContainers: containers.filter(
            (item) => item.State === "running",
          ).length,
          images: images.length,
          volumes: volumes.Volumes?.length ?? 0,
          disk: usage,
        },
        info,
      },
      errors: null,
    });
  } catch (error) {
    res
      .status(503)
      .send({
        status: "error",
        statusCode: 503,
        message:
          error instanceof Error ? error.message : "Docker host is unavailable",
        data: null,
        errors: null,
      });
  }
});

adminRouter.get("/docker/:resource", async (req, res) => {
  const resource = req.params.resource;
  const data =
    resource === "containers"
      ? await docker.listContainers({ all: true })
      : resource === "images"
        ? await docker.listImages()
        : resource === "volumes"
          ? ((await docker.listVolumes()).Volumes ?? [])
          : null;
  if (!data) {
    res
      .status(404)
      .send({
        status: "error",
        statusCode: 404,
        message: "Unknown Docker resource",
        data: null,
        errors: null,
      });
    return;
  }
  res.send({
    status: "success",
    statusCode: 200,
    message: "Docker resources",
    data,
    errors: null,
  });
});

adminRouter.delete("/docker/:resource/:id", async (req, res) => {
  try {
    if (req.params.resource === "containers")
      await docker.getContainer(req.params.id).remove({ force: true });
    else if (req.params.resource === "images")
      await docker.getImage(req.params.id).remove({ force: true });
    else if (req.params.resource === "volumes")
      await docker.getVolume(req.params.id).remove();
    else {
      res
        .status(404)
        .send({
          status: "error",
          statusCode: 404,
          message: "Unknown Docker resource",
          data: null,
          errors: null,
        });
      return;
    }
    res.send({
      status: "success",
      statusCode: 200,
      message: "Docker resource deleted",
      data: true,
      errors: null,
    });
  } catch (error) {
    res
      .status(400)
      .send({
        status: "error",
        statusCode: 400,
        message:
          error instanceof Error
            ? error.message
            : "Unable to delete Docker resource",
        data: null,
        errors: null,
      });
  }
});

export default adminRouter;
