import type { ExecutionContext } from "@nestjs/common";

import { ForbiddenException, Module, UnauthorizedException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { channel } from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";

import { XpModule } from "..";
import { decisionRuntime, decisionVectors } from "../../__tests__/decisionVectors";

describe.each([
  ["Express", () => new ExpressAdapter()],
  ["Fastify", () => new FastifyAdapter()],
] as const)("NestJS on %s", (_platform, adapter) => {
  it("maps the shared decision table through host guards and a trusted header", async () => {
    @Module({
      imports: [XpModule.register({ runtime: decisionRuntime, header: "X-Verified-User" })],
    })
    class Shop {}
    const app = await NestFactory.create(Shop, adapter(), { logger: false, abortOnError: false });
    app.useGlobalGuards({
      canActivate(context: ExecutionContext) {
        const request = context.switchToHttp().getRequest();
        const identity = request.headers.authorization;
        if (identity === "rejected") throw new UnauthorizedException("Invalid host credentials");
        if (identity === "denied") throw new ForbiddenException("Host policy denies access");
        // Replace untrusted input at the host boundary. An absent header must remain a guest
        // even if another identity is attached.
        request.headers["x-verified-user"] = identity;
        request.userId = "unused";
        return true;
      },
    });
    const errors: unknown[] = [];
    const failures = channel("xp.request.error");
    const log = (event: unknown) => errors.push(event);
    failures.subscribe(log);
    try {
      await app.listen(0, "127.0.0.1");
      const endpoint = (await app.getUrl()) + "/xp";
      for (const vector of decisionVectors) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-verified-user": "spoofed",
            ...(vector.id === null ? {} : { authorization: vector.id }),
          },
          body: JSON.stringify({ slug: vector.slug, userId: "spoofed" }),
        });
        expect(response.status, vector.name).toBe(vector.status);
        const body = await response.json();
        if ("result" in vector) {
          expect(response.headers.get("cache-control")).toBe("private, no-store");
          expect(body).toEqual({ slug: vector.result });
        }
        if (vector.status === 500) {
          expect(JSON.stringify(body)).not.toContain("private driver detail");
          expect(errors).toContainEqual(expect.objectContaining({ error: expect.any(Error) }));
        }
      }
    } finally {
      failures.unsubscribe(log);
      await app.close();
    }
  });
});
