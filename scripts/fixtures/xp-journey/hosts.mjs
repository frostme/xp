import { createServer } from "node:http";
import { once } from "node:events";
import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { xpMiddleware } from "@frostme/xp";
import { createXpGraphQL } from "@frostme/xp/server/graphql";
import express from "express";
import { createSchema, createYoga } from "graphql-yoga";

// The host authenticates opaque fixture sessions. The xp request body carries the slug.
const sessions = new Map([
  ["Bearer session-1", "shopper"], ["Bearer session-2", "alice"],
  ["Bearer session-3", "bob"], ["Bearer unregistered-session", "unregistered"],
]);
async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())),
  };
}

export async function startHosts(runtime) {
  const stops = [];
  const close = async () => { for (const stop of stops.reverse()) await stop(); };
  try {
    const app = express();
    app.locals.xp = runtime;
    const router = express.Router();
    router.use((req,_res,next) => {
      req.userId = sessions.get(req.get("authorization"));
      next();
    });
    router.use(xpMiddleware);
    app.use("/api",router);
    const rest = await listen(app);
    stops.push(rest.close);

    const xp = createXpGraphQL();
    const schema = xp.extendSchema(createSchema({
      typeDefs: "type Query { shop: String! } type Mutation { checkout: Boolean! }",
      resolvers: { Query: {shop: () => "store"}, Mutation:{ checkout:()=>true } },
    }));
    const yoga = await listen(createYoga({schema, context: ({request})=>({
      xp: runtime, userId: sessions.get(request.headers.get("authorization")),
    })}));
    stops.push(yoga.close);

    const apollo = new ApolloServer({schema});
    const {url} = await startStandaloneServer(apollo,{
      listen:{ host:"127.0.0.1", port:0 },
      context: async ({req}) => ({xp:runtime,userId:sessions.get(req.headers.authorization)}),
    });
    stops.push(()=>apollo.stop());
    return {
      transports: [
        {name:"Express REST",protocol:"rest",endpoint:rest.origin+"/api/xp"},
        {name:"Yoga GraphQL",protocol:"graphql",endpoint:yoga.origin+"/graphql"},
        {name:"Apollo GraphQL",protocol:"graphql",endpoint:url},
      ],
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
