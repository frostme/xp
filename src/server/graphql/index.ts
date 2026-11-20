import { extendSchema, GraphQLError, parse, type GraphQLSchema } from "graphql";

import type { CohortDecision } from "~/interfaces/runtime";

import { ExperimentNotFoundError } from "~/errors/experimentNotFoundError";

import type { ServerOptions } from "../detectClient";

import { readIdentity, validateExperimentSlug, type IdentityOptions } from "../request";
import { createRuntimeSelector } from "../runtimeSelector";

interface HeaderSource {
  get(name: string): string | null;
}

export interface XpGraphQLContext {
  xp?: unknown;
  userId?: unknown;
  request?: { headers: HeaderSource };
  headers?: HeaderSource;
}

export interface XpGraphQLOptions<Context extends object>
  extends ServerOptions, IdentityOptions<Context> {
  connection?: unknown;
}

const resultType = "type XPCohortResult { slug: String }";
const field = "xpResolveCohort(slug: String!): XPCohortResult!";
const typeDefs = parse(`${resultType}\ntype Mutation { ${field} }`);

function graphQLError(code: string, message: string, cause: unknown): GraphQLError {
  const error = new GraphQLError(message, { extensions: { code } });
  // Preserve the cause for host error hooks. GraphQL's originalError would copy
  // the driver's stack into Apollo responses and trigger Yoga's generic masking.
  Object.defineProperty(error, "cause", { value: cause });
  return error;
}

/** Compose the xp mutation with a new schema, or extend an existing executable schema. */
export function createXpGraphQL<Context extends object = XpGraphQLContext>(
  options: XpGraphQLOptions<Context> = {},
) {
  const selectRuntime = createRuntimeSelector(options);

  async function resolve(
    _parent: unknown,
    args: { slug: string },
    context: Context,
  ): Promise<CohortDecision> {
    let slug: string;
    try {
      slug = validateExperimentSlug(args.slug);
    } catch (cause) {
      throw graphQLError("BAD_USER_INPUT", "Expected a nonempty kebab-case experiment slug", cause);
    }

    const host = context as XpGraphQLContext | undefined;
    let id: string | number | null;
    try {
      id = await readIdentity(
        context,
        options,
        (name) => (host?.request?.headers ?? host?.headers)?.get(name),
        () => host?.userId,
      );
    } catch (cause) {
      throw graphQLError("INTERNAL_SERVER_ERROR", "Could not resolve the experiment cohort", cause);
    }
    try {
      const runtime = selectRuntime(host?.xp);
      return await runtime.resolveCohort(id, slug);
    } catch (cause) {
      if (cause instanceof ExperimentNotFoundError)
        throw graphQLError("NOT_FOUND", cause.message, cause);
      throw graphQLError("INTERNAL_SERVER_ERROR", "Could not resolve the experiment cohort", cause);
    }
  }

  return {
    typeDefs,
    resolvers: { Mutation: { xpResolveCohort: resolve } },
    extendSchema(schema: GraphQLSchema): GraphQLSchema {
      const mutation = schema.getMutationType();
      const root = mutation
        ? `extend type ${mutation.name}`
        : "extend schema { mutation: Mutation }\ntype Mutation";
      const extended = extendSchema(schema, parse(`${resultType}\n${root} { ${field} }`));
      extended.getMutationType()!.getFields()["xpResolveCohort"]!.resolve = resolve;
      return extended;
    },
  };
}
