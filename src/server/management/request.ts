import type { IncomingMessage } from "node:http";

import * as z from "zod";

import type { Experiment } from "~/entities";
import type { RolloutCommand } from "~/use-cases/experiment/rollout";

import { ValidationError } from "~/errors";

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function readJson(request: IncomingMessage & { body?: unknown }) {
  const max = 64 * 1024;
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new RequestError(415, "Send application/json.");
  if (Number(request.headers["content-length"]) > max)
    throw new RequestError(413, "Request body exceeds 64 KiB.");
  if (request.body !== undefined) {
    if (Buffer.byteLength(JSON.stringify(request.body)) > max)
      throw new RequestError(413, "Request body exceeds 64 KiB.");
    return request.body;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > max) {
      request.resume();
      throw new RequestError(413, "Request body exceeds 64 KiB.");
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestError(400, "Invalid JSON body.");
  }
}

export function sameOrigin(request: IncomingMessage, publicOrigin?: string) {
  const encrypted = "encrypted" in request.socket && request.socket.encrypted;
  const origin = publicOrigin ?? `${encrypted ? "https" : "http"}://${request.headers.host}`;
  if (request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site")
    throw new RequestError(403, "Send the request from the management page's origin.");
}

export function revisionTag(id: Experiment["id"], revision: number) {
  return '"' + Buffer.from(JSON.stringify([id, revision])).toString("base64url") + '"';
}

export function expectedVersion(request: IncomingMessage) {
  const tag = request.headers["if-match"];
  if (!tag) throw new RequestError(428, "Refresh the experiment and send its ETag in If-Match.");
  const match = /^"([a-zA-Z0-9_-]{1,1024})"$/.exec(tag);
  if (match) {
    try {
      const [id, revision] = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"));
      if (
        (typeof id === "string" || typeof id === "number") &&
        Number.isSafeInteger(revision) &&
        revision >= 0
      )
        return { id: id as Experiment["id"], revision: revision as number };
    } catch {
      /* Invalid tag is reported below. */
    }
  }
  throw new RequestError(400, "Invalid If-Match revision.");
}

const command = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.enum(["launch", "adjust"]),
    allocation: z.array(z.strictObject({ cohort: z.string(), percentage: z.number() })),
  }),
  z.strictObject({ type: z.enum(["pause", "resume"]) }),
  z.strictObject({ type: z.literal("finalize"), cohort: z.string() }),
]);
export function readCommand(input: unknown): RolloutCommand {
  const result = command.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError(
    "Invalid management command.",
    result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
  );
}
