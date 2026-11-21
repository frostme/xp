import type { CohortRuntime } from "@frostme/xp/server";
import type { ExecutionContext } from "@nestjs/common";
import type { AbstractHttpAdapter } from "@nestjs/core";

import { createRestLoader } from "@frostme/xp/client";
import { XpModule } from "@frostme/xp/server/nestjs";
import { Controller, ForbiddenException, Get, Module, UnauthorizedException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import assert from "node:assert/strict";

import { verifyManagementMount } from "./management.js";

@Controller("health")
class Health {
  @Get()
  status() {
    return { ok: true };
  }
}

async function start(adapter: AbstractHttpAdapter, variant: string, asyncRegistration: boolean) {
  const runtime: CohortRuntime = {
    driverKind: "postgres",
    async resolveCohort(id, slug) {
      if (id === null) return { slug: null };
      assert.equal(id, 0);
      return { slug: slug + "_" + variant };
    },
  };
  const token = Symbol("application.runtime");
  @Module({ providers: [{ provide: token, useValue: runtime }], exports: [token] })
  class Storage {}

  const xp = asyncRegistration
    ? XpModule.registerAsync({
        route: "/decide",
        imports: [Storage],
        inject: [token],
        useFactory: async (injected: CohortRuntime) => ({
          runtime: injected,
          userId: async (req) => req.userId,
          header: "x-forwarded-id",
          resolveBody: ({ slug }) => ({ variant: slug }),
        }),
      })
    : XpModule.register({ runtime });

  @Module({ imports: [xp], controllers: [Health] })
  class Shop {}
  const app = await NestFactory.create(Shop, adapter, { logger: false, abortOnError: false });
  app.setGlobalPrefix("shop/api");
  app.useGlobalGuards({
    canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest();
      switch (req.headers.authorization) {
        case "Bearer expired":
          throw new UnauthorizedException("Expired shop session");
        case "Bearer suspended":
          throw new ForbiddenException("Suspended shop account");
        case "Bearer verified":
          req.userId = 0;
      }
      return true;
    },
  });
  try {
    await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl();
    const endpoint = origin + "/shop/api/" + (asyncRegistration ? "decide" : "xp");
    const options = {
      endpoint,
      ...(asyncRegistration
        ? { decode: (value: unknown) => (value as { variant: unknown }).variant }
        : {}),
    };
    const load = (authorization?: string) =>
      createRestLoader({
        ...options,
        headers: { "x-forwarded-id": "untrusted", ...(authorization ? { authorization } : {}) },
      })("checkout");
    return { app, origin, endpoint, load };
  } catch (error) {
    await app.close();
    throw error;
  }
}

export async function exerciseNest(createAdapter: () => AbstractHttpAdapter) {
  const sync = await start(createAdapter(), "short", false);
  try {
    const asyncApp = await start(createAdapter(), "control", true);
    try {
      assert.deepEqual(
        await Promise.all([sync.load("Bearer verified"), asyncApp.load("Bearer verified")]),
        ["checkout_short", "checkout_control"],
      );
      for (const host of [sync, asyncApp]) {
        await verifyManagementMount(host.origin);
        assert.equal(await host.load(), null);
        await assert.rejects(host.load("Bearer expired"), /HTTP 401/);
        await assert.rejects(host.load("Bearer suspended"), /HTTP 403/);
        assert.deepEqual(await (await fetch(host.origin + "/shop/api/health")).json(), {
          ok: true,
        });
        const decision = await fetch(host.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: "checkout" }),
        });
        assert.equal(decision.status, 200);
        assert.equal(decision.headers.get("cache-control"), "private, no-store");
      }
    } finally {
      await asyncApp.app.close();
    }
  } finally {
    await sync.app.close();
  }
}
