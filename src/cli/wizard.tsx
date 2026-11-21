import { useInput } from "ink";
import { useEffect, useRef, useState } from "react";

import type CliFramework from "~/frameworks/cli";

import {
  DATABASES,
  FRONTENDS,
  ORMS,
  type ScopedDetection,
  type ScopedSetupOptions,
  type ScopedSetupPlan,
  type SetupResult,
} from "~/interfaces/setup";

import { SetupField } from "./fields";
import { FilePreview, PlanSummary, ResultSummary } from "./screens";
import { Alert } from "./termcn/components/ui/alert";
import { Box } from "./termcn/components/ui/box";
import { Confirm } from "./termcn/components/ui/confirm";
import { Heading } from "./termcn/components/ui/heading";
import { ScrollView } from "./termcn/components/ui/scroll-view";
import { Select } from "./termcn/components/ui/select";
import { Spinner } from "./termcn/components/ui/spinner";
import { StatusMessage } from "./termcn/components/ui/status-message";
import { Wizard as TermWizard } from "./termcn/components/ui/wizard";
import { FocusScope } from "./termcn/hooks/use-interaction";
import { ThemeProvider } from "./termcn/providers/theme-provider";
import { useTerminalSize } from "./use-terminal-size";

type Phase =
  | "loading"
  | "settings"
  | "field"
  | "review"
  | "groups"
  | "preview"
  | "confirm"
  | "applying"
  | "done"
  | "error";
const labels = {
  scope: "Setup scope",
  frontend: "Frontend profile",
  island: "Astro island renderer",
  transport: "Decision transport",
  endpoint: "Public endpoint",
  orm: "ORM / query tool",
  database: "Database",
  ormVersion: "ORM version",
  config: "Configuration file",
  schema: "Schema file or directory",
  migrationsDir: "Migrations directory",
  analytics: "Generate analytics outbox storage",
  models: "Generate supporting models / types",
  modelsDir: "Models directory",
  language: "Output language",
  moduleFormat: "Module format",
  userStorage: "User storage",
  userIdType: "Exact users.id type",
  userIdCollation: "User ID collation",
  userIdCharset: "User ID character set",
  tableName: "DynamoDB table name",
} as const;
type Field = keyof typeof labels;
const storageGroups: { title: string; fields: Field[] }[] = [
  { title: "Storage", fields: ["orm", "database", "ormVersion", "config", "schema"] },
  {
    title: "Output",
    fields: ["migrationsDir", "models", "modelsDir", "language", "moduleFormat", "analytics"],
  },
  {
    title: "User identity",
    fields: ["userStorage", "userIdType", "userIdCharset", "userIdCollation", "tableName"],
  },
];
function settingsGroups(
  scope?: ScopedSetupOptions["scope"],
  frontend?: ScopedSetupOptions["frontend"],
) {
  const groups = scope === "frontend" ? [] : [...storageGroups];
  if (scope === "frontend" || scope === "both")
    groups.push({
      title: "Frontend",
      fields: [
        "frontend",
        "transport",
        "endpoint",
        ...(frontend === "astro" ? ["island" as const] : []),
      ],
    });
  if (scope) groups.push({ title: "Scope", fields: ["scope"] });
  return groups;
}
function selections(field: Field): readonly string[] | undefined {
  switch (field) {
    case "scope":
      return ["storage", "frontend", "both"];
    case "frontend":
      return FRONTENDS;
    case "transport":
      return ["rest", "graphql"];
    case "orm":
      return ORMS;
    case "database":
      return DATABASES;
    case "analytics":
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
function fieldValue(options: ScopedSetupOptions, field: Field): string {
  const value = options[field];
  return field === "models" || field === "analytics"
    ? value
      ? "yes"
      : "no"
    : typeof value === "string"
      ? value
      : "";
}
function groupFor(field: Field, groups: typeof storageGroups) {
  return Math.max(
    0,
    groups.findIndex((group) => group.fields.includes(field)),
  );
}

export interface WizardProps {
  framework: CliFramework;
  options: ScopedSetupOptions;
  dryRun?: boolean;
  onFinish(code: number): void;
}

export default function Wizard(props: WizardProps) {
  return (
    <ThemeProvider>
      <SetupWizard {...props} />
    </ThemeProvider>
  );
}

function SetupWizard({
  framework,
  options: initialOptions,
  dryRun = false,
  onFinish,
}: WizardProps) {
  const [choices, setChoices] = useState(initialOptions);
  const [project, setProject] = useState<ScopedDetection>();
  const groups = settingsGroups(
    project?.options.scope ?? choices.scope,
    project?.options.frontend ?? choices.frontend,
  );
  const [plan, setPlan] = useState<ScopedSetupPlan>();
  const [phase, setPhase] = useState<Phase>("loading");
  const [group, setGroup] = useState(0);
  const [field, setField] = useState<Field>("orm");
  const [error, setError] = useState("");
  const [result, setResult] = useState<SetupResult>();
  const cancellation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const pending = useRef(0);
  const finished = useRef(false);
  const writing = useRef(false);
  const { columns, rows } = useTerminalSize();
  const width = Math.max(20, columns);
  const bodyHeight = Math.max(5, rows - (columns < 65 ? 10 : 8));

  function finish(code: number) {
    if (finished.current) return;
    finished.current = true;
    onFinish(code);
  }
  function cancel() {
    if (writing.current || finished.current) return;
    pending.current++;
    cancellation.current?.abort();
    finish(130);
  }
  async function resolve(next: ScopedSetupOptions, returnGroup?: number) {
    const operation = ++pending.current;
    cancellation.current?.abort();
    const controller = new AbortController();
    cancellation.current = controller;
    const request = { ...next, signal: controller.signal };
    setPlan(undefined);
    setPhase("loading");
    setError("");
    const current = () => mounted.current && !finished.current && operation === pending.current;
    try {
      const detection = await framework.detectScoped(request, true);
      if (!current()) return;
      setProject(detection);
      const missing = detection.missing[0];
      if (missing) {
        const required =
          missing === "userIdType" && next.userStorage === undefined ? "userStorage" : missing;
        if (!(required in labels)) throw new Error(`Missing setup choice: ${required}`);
        setField(required as Field);
        setGroup(
          returnGroup ??
            groupFor(
              required as Field,
              settingsGroups(detection.options.scope, detection.options.frontend),
            ),
        );
        setPhase(returnGroup === undefined ? "field" : "settings");
        return;
      }
      const proposed = await framework.planScoped(
        detection.options.scope ? { ...request, scope: detection.options.scope } : request,
      );
      if (!current()) return;
      setPlan(proposed);
      if (returnGroup !== undefined) {
        setGroup(returnGroup);
        setPhase("settings");
      } else {
        setGroup(settingsGroups(detection.options.scope, detection.options.frontend).length);
        setPhase("review");
      }
    } catch (reason) {
      if (current()) {
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
    if (phase === "done") finish(0);
  }, [phase]);

  async function apply() {
    if (!plan || phase !== "confirm" || writing.current || finished.current) return;
    writing.current = true;
    setPhase("applying");
    try {
      const applied = await framework.applyScoped(plan);
      if (!mounted.current) return;
      setResult(applied);
      setPhase("done");
    } catch (reason) {
      if (mounted.current) {
        // A failed apply may have changed inputs: require a fresh plan before retrying.
        setPlan(undefined);
        setError(reason instanceof Error ? reason.message : String(reason));
        setPhase("error");
      }
    } finally {
      writing.current = false;
    }
  }
  useInput((input, key) => {
    if (key.ctrl && input === "c") cancel();
  });

  function back() {
    if (finished.current || writing.current) return;
    if (phase === "field") setPhase("settings");
    else if (phase === "preview" || phase === "confirm") {
      setGroup(groups.length);
      setPhase("review");
    } else if (phase === "settings") setPhase("groups");
    else if (phase === "groups") {
      if (plan) setGroup(groups.length);
      setPhase(plan ? "review" : error ? "error" : "settings");
    } else cancel();
  }
  function submit(value: string) {
    const next = {
      ...(project?.options.scope ? { scope: project.options.scope } : {}),
      ...choices,
      [field]: field === "models" || field === "analytics" ? value === "yes" : value,
    };
    if (!value && field !== "models" && field !== "analytics") delete next[field];
    if (field === "orm") delete next.ormVersion;
    if (field === "frontend" && value !== "astro") delete next.island;
    if (field === "scope") {
      if (value === "storage")
        for (const key of ["frontend", "transport", "endpoint", "island"] as const)
          delete next[key];
      if (value === "frontend")
        for (const group of storageGroups)
          for (const key of group.fields) if (key !== "language") delete next[key];
    }
    setChoices(next);
    void resolve(
      next,
      groupFor(
        field,
        settingsGroups(
          next.scope ?? project?.options.scope,
          next.frontend ?? project?.options.frontend,
        ),
      ),
    );
  }
  function navigate(next: number) {
    if (next === groups.length) {
      void resolve(choices);
      return;
    }
    setGroup(next);
    setPhase("settings");
  }
  const resolved = { ...project?.options, ...choices };
  const fieldOptions = (groups[group]?.fields ?? []).map((key) => ({
    value: key,
    label: labels[key],
    hint: fieldValue(resolved, key) || "automatic",
  }));
  const busy = phase === "loading" || phase === "applying" || phase === "done";
  const focusId =
    phase === "field"
      ? "field"
      : phase === "settings"
        ? "settings-fields"
        : phase === "groups"
          ? "groups"
          : phase === "review"
            ? "review-actions"
            : phase === "confirm"
              ? "confirm"
              : phase === "preview"
                ? "preview-mode"
                : "error-actions";
  const body = (
    <>
      {phase === "settings" && (
        <Select
          id="settings-fields"
          label={`${groups[group]?.title} settings`}
          options={[
            ...fieldOptions,
            { value: "continue", label: "Continue to review", hint: "validate choices" },
          ]}
          onSubmit={(value) => {
            if (value === "continue") void resolve(choices);
            else {
              setField(value as Field);
              setPhase("field");
            }
          }}
        />
      )}
      {phase === "field" && (
        <>
          {project?.warnings.map((warning, i) => (
            <Alert key={i} variant="warning">
              {warning}
            </Alert>
          ))}
          <SetupField
            key={field}
            label={labels[field]}
            initial={fieldValue(resolved, field)}
            width={Math.min(65, width - 4)}
            cwd={project?.cwd ?? initialOptions.cwd ?? "."}
            choices={field === "island" ? project?.islandCandidates : selections(field)}
            path={["migrationsDir", "modelsDir", "config", "schema"].includes(field)}
            dirsOnly={field === "migrationsDir" || field === "modelsDir"}
            onSubmit={submit}
          />
        </>
      )}
      {phase === "groups" && (
        <Select
          id="groups"
          label="Edit settings"
          options={[
            ...groups.map((entry, index) => ({ value: index, label: entry.title })),
            { value: groups.length, label: "Return to review" },
          ]}
          onSubmit={navigate}
        />
      )}
      {phase === "review" && plan && (
        <>
          <ScrollView id="review-content" height={Math.max(3, bodyHeight - 7)}>
            <PlanSummary plan={plan} width={width - 2} />
          </ScrollView>
          <Select
            id="review-actions"
            label="Review actions"
            options={[
              { value: "generate", label: dryRun ? "Finish dry run" : "Generate files" },
              { value: "edit", label: "Edit settings" },
              { value: "preview", label: "Preview files" },
              { value: "cancel", label: "Cancel" },
            ]}
            onSubmit={(value) => {
              if (value === "generate") {
                if (dryRun) finish(0);
                else setPhase("confirm");
              } else if (value === "edit") setPhase("groups");
              else if (value === "preview") setPhase("preview");
              else cancel();
            }}
          />
        </>
      )}
      {phase === "preview" && plan && <FilePreview plan={plan} height={bodyHeight} />}
      {phase === "confirm" && plan && (
        <Confirm
          id="confirm"
          message={`Generate the reviewed files in ${plan.options.cwd}?`}
          confirmLabel="Generate files"
          cancelLabel="Back to review"
          onConfirm={() => {
            void apply();
          }}
          onCancel={back}
        />
      )}
    </>
  );

  return (
    <Box flexDirection="column" width={width}>
      <Heading level={1}>xp setup</Heading>
      <StatusMessage>Generate project files · Ctrl+C cancels before writing</StatusMessage>
      {phase === "loading" && (
        <Spinner label="Inspecting the project and preparing a file preview…" />
      )}
      {phase === "applying" && <Spinner label="Writing approved files…" />}
      {phase === "done" && result && <ResultSummary result={result} />}
      {!busy && (
        <FocusScope
          key={`${phase}-${group}-${field}`}
          active
          initialFocusId={focusId}
          onEscapeKey={back}
        >
          {phase === "error" ? (
            <>
              <Alert variant="error" title="Setup could not continue">
                {error}
              </Alert>
              <Select
                id="error-actions"
                label="Recovery actions"
                options={[
                  { value: "retry", label: "Retry planning" },
                  { value: "edit", label: "Edit settings" },
                  { value: "cancel", label: "Cancel" },
                ]}
                onSubmit={(value) => {
                  if (value === "retry") void resolve(choices);
                  else if (value === "edit") setPhase("groups");
                  else cancel();
                }}
              />
            </>
          ) : (
            <TermWizard
              id="wizard-navigation"
              activeStep={group}
              onStepChange={navigate}
              compact={columns < 65}
              showNavigation={phase === "settings"}
              isActive={phase === "settings"}
              completionLabel="Review files"
              steps={[
                ...groups.map((entry) => ({ key: entry.title, title: entry.title, content: body })),
                { key: "review", title: "Review", content: body },
              ]}
              onComplete={() => {
                void resolve(choices);
              }}
            />
          )}
          <StatusMessage>Tab focus · Arrows navigate · Enter select · Esc back</StatusMessage>
        </FocusScope>
      )}
    </Box>
  );
}
