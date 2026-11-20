import "reflect-metadata";
import { createRestLoader } from "@frostme/xp/client";
import { xpFastifyPlugin } from "@frostme/xp/server/fastify";
import { XpModule } from "@frostme/xp/server/nestjs";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import Fastify from "fastify";

// Opaque fixture sessions are verified by the host before xp reads userId.
const accounts = new Map([
  ["shopper", "shopper"],
  ["alice", "alice"],
  ["bob", "bob"],
  ["unregistered", "absent-user"],
]);
export function account(session) {
  return accounts.get(session);
}

export async function startRestMounts(runtime) {
  const hosts = [];
  const close = async () => Promise.all(hosts.map((app) => app.close()));
  try {
    const app = Fastify();
    hosts.push(app);
    app.addHook("preHandler", async (req) => {
      req.userId = account(req.headers.authorization);
    });
    await app.register(xpFastifyPlugin, { runtime, prefix: "/api" });
    const urls = [await app.listen({ port: 0, host: "127.0.0.1" })];

    for (const adapter of [undefined, new FastifyAdapter()]) {
      const module = XpModule.register({ runtime });
      const nest = adapter
        ? await NestFactory.create(module, adapter, { logger: false })
        : await NestFactory.create(module, { logger: false });
      hosts.push(nest);
      nest.setGlobalPrefix("api");
      nest.useGlobalGuards({
        canActivate(context) {
          const request = context.switchToHttp().getRequest();
          request.userId = account(request.headers.authorization);
          return true;
        },
      });
      await nest.listen(0, "127.0.0.1");
      urls.push(await nest.getUrl());
    }
    return {
      close,
      load: urls.map(
        (url) => (slug, session) =>
          createRestLoader({
            endpoint: url + "/api/xp",
            headers: session ? { authorization: session } : {},
          })(slug),
      ),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
