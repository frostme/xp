import type { CohortLoader } from "@frostme/xp/client";
import type { ReactNode } from "react";

import { createGrpcWebLoader } from "@frostme/xp/client/grpc-web";
import { createSoapLoader } from "@frostme/xp/client/soap";
import { XPProvider } from "@frostme/xp/react";

export const custom: CohortLoader[] = [
  createGrpcWebLoader({ experimentHost: "/api", credentials: "include" }),
  createSoapLoader({ endpoint: "/api/xp/soap", headers: { "x-client": "shop" } }),
];

export function RpcExperiments({
  children,
  sessionKey,
}: {
  children: ReactNode;
  sessionKey: string;
}) {
  return (
    <XPProvider loader="grpc-web" experimentHost="/api" sessionKey={sessionKey}>
      {children}
    </XPProvider>
  );
}
export function SoapExperiments({
  children,
  sessionKey,
}: {
  children: ReactNode;
  sessionKey: string;
}) {
  return (
    <XPProvider loader="soap" endpoint="/api/xp/soap" sessionKey={sessionKey}>
      {children}
    </XPProvider>
  );
}
