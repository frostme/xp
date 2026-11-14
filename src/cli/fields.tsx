import { Box, Text, useInput } from "ink";
import { dirname } from "node:path";
import { useEffect, useState } from "react";

import { listDirectories } from "~/adaptors/setup/directories";

interface FieldProps {
  label: string;
  initial: string;
  onSubmit(value: string): void;
  onBack(): void;
}

export function TextField({ label, initial, onSubmit, onBack }: FieldProps) {
  const [value, setValue] = useState(initial);
  useInput((input, key) => {
    if (key.escape) return onBack();
    if (key.return) return onSubmit(value.trim());
    if (key.backspace || key.delete) return setValue((current) => current.slice(0, -1));
    if (
      !key.ctrl &&
      !key.meta &&
      !key.tab &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow
    ) {
      setValue(
        (current) =>
          current +
          Array.from(input)
            .filter((char) => char.charCodeAt(0) >= 32)
            .join(""),
      );
    }
  });
  return (
    <Box flexDirection="column">
      <Text bold>{label}</Text>
      <Text color="cyan">{value}▏</Text>
      <Text dimColor>Enter to continue · Esc to go back</Text>
    </Box>
  );
}

export function SelectField({
  label,
  choices,
  initial,
  onSubmit,
  onBack,
}: Omit<FieldProps, "initial"> & { choices: string[]; initial?: string }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(Math.max(0, choices.indexOf(initial ?? "")));
  const filtered = choices.filter((value) => value.toLowerCase().includes(query.toLowerCase()));
  const index = Math.min(selected, Math.max(0, filtered.length - 1));
  useInput((input, key) => {
    if (key.escape) return onBack();
    if (key.upArrow) return setSelected(Math.max(0, index - 1));
    if (key.downArrow) return setSelected(Math.min(filtered.length - 1, index + 1));
    if (key.return) {
      const value = filtered[index];
      if (value !== undefined) onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((current) => current.slice(0, -1));
      setSelected(0);
      return;
    }
    if (!key.ctrl && !key.meta && !key.tab) {
      setQuery((current) => current + input);
      setSelected(0);
    }
  });
  return (
    <Box flexDirection="column">
      <Text bold>{label}</Text>
      <Text dimColor>Search: {query || "type to filter"}</Text>
      {filtered.map((value, position) => (
        <Text key={value} {...(position === index ? { color: "cyan" as const } : {})}>
          {position === index ? "❯ " : "  "}
          {value}
        </Text>
      ))}
      {filtered.length === 0 && <Text color="yellow">No matching choices</Text>}
      <Text dimColor>↑/↓ to choose · Enter to continue · Esc to go back</Text>
    </Box>
  );
}

export function DirectoryField({
  label,
  initial,
  cwd,
  onSubmit,
  onBack,
}: FieldProps & { cwd: string }) {
  const [directory, setDirectory] = useState(".");
  const [entries, setEntries] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [manual, setManual] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    listDirectories(cwd, directory)
      .then((values) => {
        if (active) {
          setEntries(values);
          setIndex(0);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [cwd, directory]);
  useInput((_input, key) => {
    if (manual) return;
    if (key.escape) return onBack();
    if (key.tab) return setManual(true);
    if (key.upArrow) return setIndex(Math.max(0, index - 1));
    if (key.downArrow) return setIndex(Math.min(entries.length, index + 1));
    if (key.leftArrow) return setDirectory(dirname(directory));
    if (key.rightArrow && index > 0) return setDirectory(entries[index - 1] ?? directory);
    if (key.return) onSubmit(index === 0 ? directory : (entries[index - 1] ?? directory));
  });
  if (manual)
    return (
      <TextField
        label={`${label} (new or existing path)`}
        initial={initial}
        onSubmit={onSubmit}
        onBack={() => setManual(false)}
      />
    );
  return (
    <Box flexDirection="column">
      <Text bold>{label}</Text>
      <Text dimColor>
        Browsing {directory} · suggested: {initial}
      </Text>
      {[directory, ...entries].map((value, position) => (
        <Text
          key={`${position}:${value}`}
          {...(position === index ? { color: "cyan" as const } : {})}
        >
          {position === index ? "❯ " : "  "}
          {position === 0 ? `Use ${value}` : value}
        </Text>
      ))}
      {error && <Text color="red">{error}</Text>}
      <Text dimColor>
        ↑/↓ choose · → open · ← parent · Enter select · Tab type a path · Esc back
      </Text>
    </Box>
  );
}
