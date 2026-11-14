import { useState } from "react";

import { FormField } from "./termcn/components/ui/form-field";
import { PathInput } from "./termcn/components/ui/path-input";
import { Select } from "./termcn/components/ui/select";
import { TextInput } from "./termcn/components/ui/text-input";

interface FieldProps {
  label: string;
  initial: string;
  onSubmit(value: string): void;
  width: number;
  cwd: string;
  choices?: readonly string[] | undefined;
  path?: boolean;
  dirsOnly?: boolean;
}

export function SetupField({
  label,
  initial,
  onSubmit,
  width,
  cwd,
  choices,
  path,
  dirsOnly,
}: FieldProps) {
  const [value, setValue] = useState(initial);
  const submit = (next: string) => onSubmit(next.trim());
  return (
    <FormField label={label} hint="Enter to save · Esc to return without changing">
      {choices ? (
        <Select
          id="field"
          aria-label={label}
          options={choices.map((choice) => ({ value: choice, label: choice }))}
          defaultValue={initial}
          onSubmit={submit}
        />
      ) : path ? (
        <PathInput
          id="field"
          aria-label={label}
          cwd={cwd}
          value={value}
          onValueChange={setValue}
          onSubmit={submit}
          dirsOnly={Boolean(dirsOnly)}
          width={width}
        />
      ) : (
        <TextInput
          id="field"
          aria-label={label}
          value={value}
          onValueChange={setValue}
          onSubmit={submit}
          width={width}
        />
      )}
    </FormField>
  );
}
