import type { GeneratedFile, SetupLanguage } from "~/interfaces/setup";

export interface FrontendContext {
  cwd: string;
  frontend: string;
  transport: "rest" | "graphql";
  endpoint: string;
  language: SetupLanguage;
  versions: Record<string, string>;
  island: string;
  /** Reads application source without executing it, checking path safety and recording its fingerprint. */
  read(path: string): Promise<string | null>;
}

export interface FrontendOutput {
  owned: GeneratedFile[];
  registrations: { path: string; kind: string; content: string }[];
  manual: string[];
  nextSteps?: string[];
}

export interface FrontendProfile {
  id: string;
  packages: Record<string, string>;
  optionalPackages?: string[];
  supersedes?: string[];
  generate(context: FrontendContext): Promise<FrontendOutput>;
}
