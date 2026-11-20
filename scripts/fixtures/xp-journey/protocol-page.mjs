import { createGrpcWebLoader } from "@frostme/xp/client/grpc-web";
import { createSoapLoader } from "@frostme/xp/client/soap";

// Execute the packed browser transports inside Chromium, including its cookie and CORS checks.
export function decisions(slug) {
  return Promise.allSettled([
    createGrpcWebLoader({ experimentHost: "/api" })(slug),
    createGrpcWebLoader({
      experimentHost: "http://127.0.0.1:18182/api",
      credentials: "include",
    })(slug),
    createSoapLoader({ endpoint: "/api/xp/soap" })(slug),
  ]).then((results) =>
    results.map((result) =>
      result.status === "fulfilled" ? { value: result.value } : { error: result.reason.message },
    ),
  );
}
