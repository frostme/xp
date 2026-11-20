import type { Request, Response, NextFunction } from "express";

import { channel } from "node:diagnostics_channel";
import { createRequire } from "node:module";

import type { CohortDecision } from "~/interfaces/runtime";

import { ValidationError } from "~/errors";
import { ExperimentNotFoundError } from "~/errors/experimentNotFoundError";

import { readIdentity, validateExperimentSlug } from "../request";
import { createRuntimeSelector } from "../runtimeSelector";

const require = createRequire(import.meta.url);
const failures = channel("xp.request.error");

/** Structural signatures keep the root declaration usable without Express types. */
interface HostRequest {
  app: { locals: Record<string, unknown> };
  body?: unknown;
  userId?: unknown;
  get(name: string): string | undefined;
}
interface HostResponse {
  status(code: number): unknown;
}
type Handler = (
  request: HostRequest,
  response: HostResponse,
  next: (error?: unknown) => void,
) => unknown;

export interface MiddlewareOptions<R extends HostRequest = HostRequest> {
  route?: string;
  connection?: unknown;
  databaseName?: string;
  tableName?: string;
  userId?: (request: R) => unknown;
  header?: string;
  resolveBody?: (result: CohortDecision) => unknown;
}

function createHandler<R extends HostRequest>(options: MiddlewareOptions<R>): Handler {
  const select = createRuntimeSelector(options);
  const express: typeof import("express") = require("express");
  const router = express.Router();
  const route = options.route ?? "/xp";
  router.post(
    route.startsWith("/") ? route : "/" + route,
    (_req, res, next) => {
      res.set("Cache-Control", "private, no-store");
      next();
    },
    express.json(),
    async (req, res) => {
      const request = req as Request & R;
      let slug: string;
      try {
        slug = validateExperimentSlug(request.body?.slug);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        res.status(400).json({ error: "Invalid experiment slug" });
        return;
      }
      const id = await readIdentity(
        request,
        options,
        (name) => req.get(name),
        () => request.userId,
      );
      const runtime = select(req.app.locals["xp"]);
      let decision: CohortDecision;
      try {
        decision = await runtime.resolveCohort(id, slug);
      } catch (error) {
        if (!(error instanceof ExperimentNotFoundError)) throw error;
        res.status(404).json({ error: "Experiment not found" });
        return;
      }
      res.json(options.resolveBody ? await options.resolveBody(decision) : decision);
    },
  );
  router.use((error: unknown, request: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    failures.publish({ error, request });
    const parseError = error && typeof error === "object" && "type" in error ? error.type : null;
    const status =
      parseError === "entity.parse.failed" ? 400 : parseError === "entity.too.large" ? 413 : 500;
    res
      .status(status)
      .json({ error: status === 500 ? "Internal server error" : "Invalid JSON request" });
  });
  return router as unknown as Handler;
}

let bare: Handler | undefined;
export function xpMiddleware(
  request: HostRequest,
  response: HostResponse,
  next: (error?: unknown) => void,
): unknown;
export function xpMiddleware<R extends HostRequest = HostRequest>(
  options?: MiddlewareOptions<R>,
): Handler;
export function xpMiddleware<R extends HostRequest>(
  first: MiddlewareOptions<R> | HostRequest = {},
  response?: HostResponse,
  next?: (error?: unknown) => void,
): unknown {
  if (response && next) {
    bare ??= createHandler({});
    return bare(first as HostRequest, response, next);
  }
  return createHandler(first as MiddlewareOptions<R>);
}
