import express, { type NextFunction, type Request, type Response } from "express";
import { healthRouter } from "./routes/health.js";
import { yumiRouter } from "./routes/yumi.js";
import { createClientFromEnv, type YumiClient } from "./yumi/index.js";

export function createApp(yumi: YumiClient = createClientFromEnv()) {
  const app = express();

  app.use(express.json());

  app.use("/health", healthRouter);
  app.use("/", yumiRouter(yumi));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not Found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number })?.status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: (err as Error).message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  });

  return app;
}
