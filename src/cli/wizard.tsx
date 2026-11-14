import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";

import type CliFramework from "~/frameworks/cli";

import {
  DATABASES,
  ORMS,
  type ProjectDetection,
  type SetupOptions,
  type SetupPlan,
  type SetupResult,
} from "~/interfaces/setup";

import { DirectoryField, SelectField, TextField } from "./fields";
import { describePlan, describeResult, previewFile } from "./presentation";

type Phase = "loading" | "field" | "review" | "edit" | "preview" | "applying" | "done" | "error";
const labels: Partial<Record<keyof SetupOptions, string>> = {
  orm: "ORM / query tool",
  database: "Database",
  config: "Configuration file",
  schema: "Schema file or directory",
  migrationsDir: "Migrations directory",
  models: "Generate supporting models / types",
  modelsDir: "Models directory",
  language: "Output language",
  moduleFormat: "Module format",
  userStorage: "User storage",
  userIdType: "Exact users.id type",
  userIdCollation: "User ID collation",
  userIdCharset: "User ID character set",
  tableName: "DynamoDB table name",
  ormVersion: "ORM version",
};
const editFields = Object.keys(labels) as (keyof SetupOptions)[];
function selections(field: keyof SetupOptions): readonly string[] | undefined {
  switch (field) {
    case "orm":
      return ORMS;
    case "database":
      return DATABASES;
    case "models":
      return ["no", "yes"];
    case "language":
      return ["typescript", "javascript"];
    case "moduleFormat":
      return ["esm", "commonjs"];
    case "userStorage":
      return ["reuse", "create"];
    default:
      return undefined;
  }
}

export interface WizardProps {
  framework: CliFramework;
  options: SetupOptions;
  dryRun?: boolean;
  onFinish(code: number): void;
}

export default function Wizard({
  framework,
  options: initialOptions,
  dryRun = false,
  onFinish,
}: WizardProps) {
  const [choices, setChoices] = useState(initialOptions);
  const [project, setProject] = useState<ProjectDetection>();
  const [plan, setPlan] = useState<SetupPlan>();
  const [phase, setPhase] = useState<Phase>("loading");
  const [field, setField] = useState<keyof SetupOptions>("orm");
  const [error, setError] = useState("");
  const [result, setResult] = useState<SetupResult>();
  const [fileIndex, setFileIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [horizontal, setHorizontal] = useState(0);
  const cancellation = useRef<AbortController | null>(null);
  const history = useRef<SetupOptions[]>([]);
  const mounted = useRef(true);
  const pending = useRef(0);
  const { stdout } = useStdout();
  const pageSize = Math.max(
    6,
    ("rows" in stdout && typeof stdout.rows === "number" ? stdout.rows : 24) - 7,
  );

  async function resolve(next: SetupOptions) {
    const operation = ++pending.current;
    cancellation.current?.abort();
    const controller = new AbortController();
    cancellation.current = controller;
    const request = { ...next, signal: controller.signal };
    setPlan(undefined);
    setPhase("loading");
    setError("");
    try {
      const detection = await framework.detectProject(request);
      if (!mounted.current || operation !== pending.current) return;
      setProject(detection);
      const missing = detection.missing[0];
      if (missing) {
        setField(
          missing === "userIdType" && next.userStorage === undefined ? "userStorage" : missing,
        );
        setPhase("field");
        return;
      }
      const proposed = await framework.planSetup(request);
      if (!mounted.current || operation !== pending.current) return;
      setPlan(proposed);
      setPhase("review");
    } catch (reason) {
      if (mounted.current && operation === pending.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setPhase("error");
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    void resolve(initialOptions);
    return () => {
      mounted.current = false;
      pending.current++;
      cancellation.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (phase === "done") onFinish(0);
  }, [phase, onFinish]);

  function cancel() {
    if (phase === "applying") return;
    pending.current++;
    cancellation.current?.abort();
    onFinish(130);
  }

  async function apply() {
    if (!plan) return;
    if (dryRun) {
      onFinish(0);
      return;
    }
    setPhase("applying");
    try {
      const applied = await framework.applySetup(plan);
      if (!mounted.current) return;
      setResult(applied);
      setPhase("done");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase("error");
    }
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      cancel();
      return;
    }
    if (key.ctrl && input === "e" && phase === "field") {
      setPhase("edit");
      return;
    }
    if (phase === "review") {
      if (input === "e") setPhase("edit");
      else if (input === "p") {
        setFileIndex(0);
        setOffset(0);
        setHorizontal(0);
        setPhase("preview");
      } else if (input === "q" || key.escape) cancel();
      else if (input === "g" || key.return) void apply();
    } else if (phase === "error") {
      if (input === "e") setPhase("edit");
      else if (input === "r") void resolve(choices);
      else if (input === "q" || key.escape) cancel();
    } else if (phase === "preview" && plan) {
      if (key.escape || input === "q") setPhase("review");
      else if (key.tab && !key.shift) {
        setFileIndex(Math.min(plan.files.length - 1, fileIndex + 1));
        setOffset(0);
        setHorizontal(0);
      } else if (key.tab && key.shift) {
        setFileIndex(Math.max(0, fileIndex - 1));
        setOffset(0);
        setHorizontal(0);
      } else if (key.rightArrow) {
        const width = Math.max(
          0,
          ...previewFile(plan, fileIndex).map((line) => Array.from(line).length),
        );
        setHorizontal(Math.min(width, horizontal + 20));
      } else if (key.leftArrow) {
        setHorizontal(Math.max(0, horizontal - 20));
      } else if (key.downArrow || key.pageDown)
        setOffset(
          Math.min(
            Math.max(0, previewFile(plan, fileIndex).length - pageSize),
            offset + (key.pageDown ? pageSize : 1),
          ),
        );
      else if (key.upArrow || key.pageUp)
        setOffset(Math.max(0, offset - (key.pageUp ? pageSize : 1)));
    }
  });

  function back() {
    if (plan) {
      setPhase("edit");
      return;
    }
    const previous = history.current.pop();
    if (previous) {
      setChoices(previous);
      void resolve(previous);
    } else cancel();
  }

  function submit(value: string) {
    history.current.push(choices);
    const next = { ...choices, [field]: field === "models" ? value === "yes" : value };
    if (!value && field !== "models") delete next[field];
    if (field === "orm") {
      delete next.ormVersion;
      // Derived paths are not copied into choices, so changing the tool redetects them.
    }
    setChoices(next);
    void resolve(next);
  }

  const current = project?.options[field];
  const initial =
    field === "models" ? (current ? "yes" : "no") : typeof current === "string" ? current : "";
  const label = labels[field] ?? field;
  const select = selections(field);

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold color="cyan">
        xp setup
      </Text>
      <Text dimColor>Generate project files · Ctrl+C to cancel before writing</Text>
      <Box marginTop={1} flexDirection="column">
        {phase === "loading" && <Text>Inspecting the project and preparing a file preview…</Text>}
        {phase === "field" && (
          <>
            <Text dimColor>Ctrl+E to edit any setup choice</Text>
            {project?.warnings.map((warning) => (
              <Text key={warning} color="yellow">
                {warning}
              </Text>
            ))}
            {select ? (
              <SelectField
                key={field}
                label={label}
                choices={[...select]}
                initial={initial}
                onSubmit={submit}
                onBack={back}
              />
            ) : field === "migrationsDir" || field === "modelsDir" ? (
              <DirectoryField
                key={field}
                label={label}
                cwd={project?.cwd ?? "."}
                initial={initial}
                onSubmit={submit}
                onBack={back}
              />
            ) : (
              <TextField
                key={field}
                label={label}
                initial={initial}
                onSubmit={submit}
                onBack={back}
              />
            )}
          </>
        )}
        {phase === "review" && plan && (
          <>
            <Text>{describePlan(plan)}</Text>
            <Text color="cyan">
              {dryRun ? "Enter finish dry run" : "Enter generate files"} · e edit choices · p
              preview contents · q cancel
            </Text>
          </>
        )}
        {phase === "edit" && (
          <SelectField
            label="Edit a setup choice"
            choices={editFields.map((key) => labels[key] ?? key)}
            onBack={() => setPhase(plan ? "review" : project?.missing.length ? "field" : "error")}
            onSubmit={(value) => {
              const selected = editFields.find((key) => labels[key] === value);
              if (selected) {
                setField(selected);
                setPhase("field");
              }
            }}
          />
        )}
        {phase === "preview" && plan && (
          <>
            <Text bold>
              {fileIndex + 1}/{plan.files.length} {plan.files[fileIndex]?.path}
            </Text>
            {previewFile(plan, fileIndex)
              .slice(offset, offset + pageSize)
              .map((line, i) => (
                <Text
                  key={offset + i}
                  wrap="truncate"
                  {...(line.startsWith("+")
                    ? { color: "green" as const }
                    : line.startsWith("-")
                      ? { color: "red" as const }
                      : {})}
                >
                  {Array.from(line).slice(horizontal).join("")}
                </Text>
              ))}
            <Text dimColor>
              Tab/Shift+Tab file · ←/→ horizontal · ↑/↓ or PgUp/PgDn scroll · Esc return
            </Text>
          </>
        )}
        {phase === "applying" && <Text>Writing approved files…</Text>}
        {phase === "done" && result && <Text>{describeResult(result)}</Text>}
        {phase === "error" && (
          <>
            <Text color="red">{error}</Text>
            <Text>e edit choices · r retry · q cancel</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
