import type { IncomingMessage, ServerResponse } from "node:http";

import { channel } from "node:diagnostics_channel";

import type { ManagementAccess } from "~/interfaces/management";
import type { createExperimentManagement } from "~/use-cases/experiment/management";

import { ExperimentSlugConflictError, NotFoundError, ValidationError } from "~/errors";
import { ManagementForbiddenError } from "~/errors/managementForbiddenError";
import { RolloutConflictError } from "~/errors/rolloutConflictError";
import { validateExperimentSlug } from "~/use-cases/user/validateExperimentSlug";

import { directoryCursors } from "./cursor";
import {
  expectedVersion,
  readCommand,
  readJson,
  RequestError,
  revisionTag,
  sameOrigin,
} from "./request";

export type {
  DirectoryEntry,
  DirectoryPage,
  ManagementAccess,
  ManagementDetail,
} from "~/interfaces/management";
export type { Allocation, RolloutCommand } from "~/use-cases/experiment/rollout";
export interface ManagementOptions<Request extends IncomingMessage = IncomingMessage> {
  runtime: { management: ReturnType<typeof createExperimentManagement> };
  basePath: string;
  access?: (request: Request) => ManagementAccess | Promise<ManagementAccess>;
  /** Public origin when TLS terminates at a trusted proxy. */
  origin?: string;
  /** Optional 32-byte key shared by replicas that serve the same mount. */
  cursorKey?: Uint8Array;
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function createXpManagementHandler<Request extends IncomingMessage = IncomingMessage>(
  options: ManagementOptions<Request>,
) {
  const base = options.basePath.replace(/\/$/, "");
  if (
    !/^([/][a-zA-Z0-9_~-]+(?:\.[a-zA-Z0-9_~-]+)*)*$/.test(base) ||
    !options.basePath.startsWith("/")
  )
    throw new TypeError("basePath must be a root-relative mount path.");
  if (options.origin && !/^https?:$/.test(new URL(options.origin).protocol))
    throw new TypeError("Use an HTTP(S) public origin.");
  const origin = options.origin && new URL(options.origin).origin;
  const service = options.runtime.management;
  const cursors = directoryCursors(base, options.cursorKey);
  return async function management(request: Request, response: ServerResponse, next?: () => void) {
    const target =
      (request as Request & { originalUrl?: string }).originalUrl ?? request.url ?? "/";
    if (!target.startsWith("/") || target.startsWith("//")) {
      if (next) return next();
      return json(response, 404, { error: "Not found." });
    }
    const url = new URL(target, "http://xp.invalid");
    if (url.pathname !== base && !url.pathname.startsWith(base + "/")) {
      if (next) return next();
      return json(response, 404, { error: "Not found." });
    }
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const access = await options.access?.(request);
      if (access !== "view" && access !== "manage")
        throw new RequestError(403, "Experiment access is required.");
      const path = url.pathname.slice(base.length);
      const parts = /^\/api\/experiments\/([^/]+)(\/commands)?$/.exec(path);
      if (request.method === "GET") {
        if (path === "/api/capabilities")
          return json(response, 200, {
            access,
            allowCreate: access === "manage" && service.allowCreate,
          });
        if (path === "/api/experiments") {
          const query = (url.searchParams.get("q") ?? "").trim();
          const rawLimit = url.searchParams.get("limit") ?? "25";
          if (
            query.includes("\0") ||
            query.length > 256 ||
            !/^[1-9]\d{0,2}$/.test(rawLimit) ||
            Number(rawLimit) > 100
          )
            throw new RequestError(
              400,
              "Use a search of up to 256 characters and a limit of 1–100.",
            );
          const token = url.searchParams.get("cursor");
          const page = await service.list({
            query,
            limit: Number(rawLimit),
            ...(token === null ? {} : { cursor: cursors.open(token, query) }),
          });
          return json(response, 200, {
            items: page.items,
            nextCursor: page.nextCursor ? cursors.seal(page.nextCursor, query) : null,
          });
        }
        if (parts && !parts[2]) {
          const detail = await service.detail(validateExperimentSlug(parts[1]), access);
          response.setHeader("ETag", revisionTag(detail.id, detail.revision));
          return json(response, 200, detail);
        }
      }
      if (request.method === "POST" && (path === "/api/experiments" || parts?.[2])) {
        if (access !== "manage") throw new RequestError(403, "Manage access is required.");
        sameOrigin(request, origin);
        if (path === "/api/experiments") {
          if (!service.allowCreate)
            throw new ManagementForbiddenError("Experiment creation is disabled.");
          const input = await readJson(request);
          const created = await service.create(input as Parameters<typeof service.create>[0]);
          response.setHeader("Location", base + "/api/experiments/" + created.slug);
          return json(response, 201, { slug: created.slug });
        }
        const slug = validateExperimentSlug(parts![1]);
        const { id, revision } = expectedVersion(request);
        await service.apply(slug, revision, readCommand(await readJson(request)), id);
        return json(response, 200, { slug });
      }
      if (parts || path === "/api/capabilities" || path === "/api/experiments") {
        response.setHeader(
          "Allow",
          parts?.[2] ? "POST" : path === "/api/experiments" ? "GET, POST" : "GET",
        );
        throw new RequestError(405, "Method unavailable.");
      }
      throw new RequestError(404, "Management route not found.");
    } catch (error) {
      if (error instanceof ValidationError)
        return json(response, 422, { error: error.message, fields: error.details });
      if (error instanceof RolloutConflictError || error instanceof ExperimentSlugConflictError)
        return json(response, 409, {
          error: error.message,
          refresh: url.pathname.replace(/\/commands$/, ""),
        });
      if (error instanceof NotFoundError) return json(response, 404, { error: error.message });
      if (error instanceof ManagementForbiddenError)
        return json(response, 403, { error: error.message });
      if (error instanceof RequestError)
        return json(response, error.status, { error: error.message });
      channel("xp.request.error").publish({ error, path: url.pathname });
      return json(response, 500, { error: "The management request failed." });
    }
  };
}
