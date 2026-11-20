import { useState } from "react";

import type { ScopedSetupPlan, SetupResult } from "~/interfaces/setup";

import { describeResult } from "./presentation";
import { Alert } from "./termcn/components/ui/alert";
import { Box } from "./termcn/components/ui/box";
import { Code } from "./termcn/components/ui/code";
import { DiffView } from "./termcn/components/ui/diff-view";
import { KeyValue } from "./termcn/components/ui/key-value";
import { ScrollView } from "./termcn/components/ui/scroll-view";
import { Select } from "./termcn/components/ui/select";
import { StatusMessage } from "./termcn/components/ui/status-message";
import { Table } from "./termcn/components/ui/table";

export function PlanSummary({ plan, width }: { plan: ScopedSetupPlan; width: number }) {
  const o = plan.options;
  return (
    <Box flexDirection="column">
      {o.scope === "storage" && <StatusMessage>Scope: storage</StatusMessage>}
      {o.scope !== "frontend" && (
        <>
          <StatusMessage>{`Using ${o.orm}${o.ormVersion ? ` ${o.ormVersion}` : ""} with ${o.database}`}</StatusMessage>
          <KeyValue
            keyWidth={Math.min(12, Math.floor(width / 3))}
            items={[
              { key: "Project", value: o.cwd },
              { key: "Migrations", value: o.migrationsDir ?? "" },
              ...(o.config ? [{ key: "Config", value: o.config }] : []),
              ...(o.schema ? [{ key: "Schema", value: o.schema }] : []),
              { key: "Models", value: o.models ? (o.modelsDir ?? "") : "not requested" },
              { key: "Language", value: `${o.language}; ${o.moduleFormat}` },
              { key: "Users", value: `${o.userStorage} users.id (${o.userIdType})` },
              ...(o.userIdCharset ? [{ key: "Charset", value: o.userIdCharset }] : []),
              ...(o.userIdCollation ? [{ key: "Collation", value: o.userIdCollation }] : []),
              ...(o.database === "dynamodb" ? [{ key: "Table", value: o.tableName ?? "" }] : []),
            ]}
          />
        </>
      )}
      {o.frontend && (
        <StatusMessage>{`Scope: ${o.scope} · ${o.frontend} · ${o.transport} ${o.endpoint}`}</StatusMessage>
      )}
      <Table
        isActive={false}
        data={plan.files.map((file) => ({ action: file.action, path: file.path }))}
        maxRows={plan.files.length}
        columns={[
          { key: "action", header: "Action", width: 9 },
          { key: "path", header: "File", width: Math.max(6, width - 18) },
        ]}
      />
      {plan.files.map((file) => (
        <StatusMessage key={file.path}>{`${file.path}: ${file.purpose}`}</StatusMessage>
      ))}
      {o.frontend &&
        plan.files
          .filter((file) => file.action === "update" && file.merge)
          .map((file) => (
            <Box key={file.path} flexDirection="column">
              <StatusMessage>{file.path}</StatusMessage>
              <DiffView oldText={file.before ?? ""} newText={file.content} mode="inline" />
            </Box>
          ))}
      {plan.warnings.map((warning, i) => (
        <Alert key={`warning-${i}`} variant="warning">
          {warning}
        </Alert>
      ))}
      {plan.prerequisites.map((step, i) => (
        <Alert key={`step-${i}`} title="Manual step">
          {step}
        </Alert>
      ))}
    </Box>
  );
}

export function ResultSummary({ result }: { result: SetupResult }) {
  return (
    <StatusMessage variant={result.status === "manual-steps-required" ? "warning" : "success"}>
      {describeResult(result)}
    </StatusMessage>
  );
}

type PreviewMode = "diff" | "before" | "after";
export function FilePreview({ plan, height }: { plan: ScopedSetupPlan; height: number }) {
  const [fileIndex, setFileIndex] = useState(0);
  const [mode, setMode] = useState<PreviewMode>("diff");
  const [choosingFile, setChoosingFile] = useState(false);
  const file = plan.files[fileIndex];
  if (!file) return <StatusMessage>No files to preview.</StatusMessage>;
  if (choosingFile)
    return (
      <Select
        id="preview-files"
        label="Choose a file"
        options={plan.files.map((entry, index) => ({ value: index, label: entry.path }))}
        maxVisible={Math.max(3, height - 2)}
        defaultValue={fileIndex}
        onSubmit={(index) => {
          setFileIndex(index);
          setMode("diff");
          setChoosingFile(false);
        }}
      />
    );
  return (
    <Box flexDirection="column">
      <StatusMessage>{`${fileIndex + 1}/${plan.files.length} ${file.path}`}</StatusMessage>
      <Select
        id="preview-mode"
        label="Preview view"
        value={mode}
        options={[
          { value: "diff", label: "Changes" },
          { value: "before", label: "Complete before" },
          { value: "after", label: "Complete after" },
          { value: "file", label: "Choose another file" },
        ]}
        onSubmit={(value) =>
          value === "file" ? setChoosingFile(true) : setMode(value as PreviewMode)
        }
      />
      <ScrollView
        key={`${fileIndex}-${mode}`}
        id="preview-content"
        height={Math.max(3, height - 7)}
      >
        {mode === "diff" && file.action !== "unchanged" ? (
          <DiffView oldText={file.before ?? ""} newText={file.content} mode="inline" />
        ) : mode === "before" && file.before === null ? (
          <StatusMessage>This file does not exist yet.</StatusMessage>
        ) : (
          <Code>{mode === "before" ? (file.before ?? "") : file.content}</Code>
        )}
      </ScrollView>
    </Box>
  );
}
