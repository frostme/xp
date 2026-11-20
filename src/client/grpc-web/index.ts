import { isFieldSet } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";

import { isSlugPart } from "~/entities/slug";
import { CohortService, ResolveCohortResponseSchema } from "~/proto/xp/v1/cohort_pb";

import { decodeAssignment, type CohortLoader, type LoaderOptions } from "../loaders/shared";

const methodPath = `/${CohortService.typeName}/${CohortService.method.resolveCohort.name}`;

function transportBase({ endpoint, experimentHost = "" }: LoaderOptions): string {
  const address = endpoint ?? experimentHost.replace(/\/+$/, "");
  if (/[?#]/.test(address)) {
    throw new TypeError("A gRPC-Web method URL cannot include a query or fragment");
  }
  const path = new URL(address || "/", "http://localhost").pathname;
  if (endpoint !== undefined && !path.endsWith(methodPath)) {
    throw new TypeError(`Expected a gRPC-Web endpoint ending in ${methodPath}`);
  }
  return path.endsWith(methodPath) ? address.slice(0, -methodPath.length) : address;
}

export function createGrpcWebLoader(options: LoaderOptions = {}): CohortLoader {
  const transport = createGrpcWebTransport({
    baseUrl: transportBase(options),
    useBinaryFormat: true,
    // Connect calls Fetch directly. Bun additionally declares a static preconnect method.
    fetch: ((input, init) =>
      (options.fetch ?? globalThis.fetch)(input, {
        ...init,
        credentials: options.credentials ?? "same-origin",
      })) as typeof globalThis.fetch,
  });
  const client = createClient(CohortService, transport);
  return async (slug, { signal } = {}) => {
    if (!isSlugPart(slug)) throw new TypeError("Expected a nonempty kebab-case experiment slug");
    const result = await client.resolveCohort(
      { slug },
      {
        ...(signal && { signal }),
        ...(options.headers && { headers: options.headers }),
      },
    );
    const present = isFieldSet(result, ResolveCohortResponseSchema.field.slug);
    return decodeAssignment(present ? result.slug : null, slug);
  };
}
