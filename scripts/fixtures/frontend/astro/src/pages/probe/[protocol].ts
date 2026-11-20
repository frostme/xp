import type { APIRoute } from "astro";

// Deliberately strict: a path or body mismatch turns the rendered result into an error.
export const POST: APIRoute = async ({ params, request }) => {
  const payload = await request.json();
  const slug = "checkout-banner";
  const decision = { slug: slug + "_on" };
  const keys = Object.keys(payload).sort().join(",");
  if (params.protocol === "rest" && keys === "slug" && payload.slug === slug) {
    return Response.json(decision);
  }
  if (
    params.protocol === "graphql" &&
    keys === "operationName,query,variables" &&
    payload.operationName === "XpResolveCohort" &&
    payload.variables.slug === slug &&
    Object.keys(payload.variables).length === 1
  ) {
    return Response.json({ data: { xpResolveCohort: decision } });
  }
  return new Response("Unexpected decision body", { status: 400 });
};
