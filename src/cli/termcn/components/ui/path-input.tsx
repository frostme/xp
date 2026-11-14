import { Box, Text } from "ink";
// Adapted from shadcn-labs/termcn (MIT). See src/cli/termcn/README.md.
import { readdirSync, lstatSync, realpathSync } from "node:fs";
import { join, dirname, basename, resolve, relative, isAbsolute, sep } from "node:path";
import { useState } from "react";

import { useInteraction } from "~/cli/termcn/hooks/use-interaction";
import { useTheme } from "~/cli/termcn/hooks/use-theme";
import { useUnicode } from "~/cli/termcn/hooks/use-unicode";
import { resolveBorderStyle } from "~/cli/termcn/lib/terminal-style";
import { resolveTerminalSymbol } from "~/cli/termcn/lib/terminal-symbols";
import { graphemeLength, removeGraphemeBefore } from "~/cli/termcn/lib/terminal-text";

export interface PathInputProps {
  cwd?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  label?: string;
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
  width?: number;
  filter?: string;
  dirsOnly?: boolean;
  isActive?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  "aria-label"?: string;
}

/** Complete paths inside the selected project, without following symlink entries. */
export const getCompletions = (
  inputPath: string,
  cwd: string,
  filter?: string,
  dirsOnly?: boolean,
): string[] => {
  try {
    const root = realpathSync(cwd);
    const target = resolve(root, inputPath || ".");
    const inside = (path: string) => {
      const rel = relative(root, path);
      return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
    };
    if (!inside(target)) return [];
    const dir = inputPath.endsWith(sep) || !inputPath ? target : dirname(target);
    const prefix = inputPath.endsWith(sep) || !inputPath ? "" : basename(target);
    // Check every existing component: an intermediate symlink is unsafe too.
    let cursor = root;
    for (const part of relative(root, dir).split(sep).filter(Boolean)) {
      cursor = join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) return [];
    }
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.name.startsWith(prefix) &&
          !entry.isSymbolicLink() &&
          !entry.name.startsWith(".") &&
          entry.name !== "node_modules" &&
          (!dirsOnly || entry.isDirectory()) &&
          (!filter || entry.isDirectory() || entry.name.endsWith(filter)),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 5)
      .map((entry) => {
        const path = join(dir, entry.name);
        return (
          (isAbsolute(inputPath) ? path : relative(root, path)) + (entry.isDirectory() ? sep : "")
        );
      });
  } catch {
    return [];
  }
};

export const PathInput = ({
  cwd = process.cwd(),
  value: controlledValue,
  defaultValue = "",
  onValueChange,
  onChange,
  onSubmit,
  label,
  placeholder = "/",
  autoFocus = false,
  id,
  width = 40,
  filter,
  dirsOnly = false,
  isActive = true,
  disabled = false,
  readOnly = false,
  required = false,
  "aria-label": ariaLabel,
}: PathInputProps) => {
  const unicode = useUnicode();
  const cursor = resolveTerminalSymbol(unicode, "█", "|");
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [completionIndex, setCompletionIndex] = useState(0);
  const theme = useTheme();

  const value = controlledValue ?? internalValue;
  const applyChange = (nextValue: string) => {
    const changeHandler = onValueChange ?? onChange;
    if (changeHandler) {
      changeHandler(nextValue);
    } else {
      setInternalValue(nextValue);
    }
  };

  const { isFocused } = useInteraction(
    (input, key) => {
      if (key.tab || key.ctrl || key.meta) return;
      const completionOptions = getCompletions(value, cwd, filter, dirsOnly);

      if (key.return) {
        onSubmit?.(value);
        return;
      }

      if (key.rightArrow) {
        if (!readOnly && completionOptions.length > 0) {
          const selected = completionOptions[completionIndex] ?? completionOptions[0];
          if (selected !== undefined) applyChange(selected);
          setCompletionIndex(0);
        }
        return;
      }

      if (key.upArrow) {
        setCompletionIndex((c) => Math.max(0, c - 1));
        return;
      }

      if (key.downArrow) {
        setCompletionIndex((c) => Math.min(completionOptions.length - 1, c + 1));
        return;
      }

      if (readOnly) {
        return;
      }

      if (key.backspace || key.delete) {
        const newVal = removeGraphemeBefore(value, graphemeLength(value)).value;
        setCompletionIndex(0);
        applyChange(newVal);
        return;
      }

      if (key.escape) {
        return;
      }

      if (input && !(key.ctrl || key.meta)) {
        setCompletionIndex(0);
        applyChange(value + input);
      }
    },
    { autoFocus, disabled, id, isActive },
  );

  const completions =
    isFocused && value.length > 0 ? getCompletions(value, cwd, filter, dirsOnly) : [];

  const borderColor = isFocused ? theme.colors.focusRing : theme.colors.border;

  return (
    <Box flexDirection="column">
      {label && <Text bold>{label}</Text>}
      <Box
        aria-label={ariaLabel ?? `${label ?? "Path"}: ${value || "empty"}`}
        aria-role="textbox"
        aria-state={{ disabled, readonly: readOnly, required }}
        borderStyle={resolveBorderStyle("round", unicode)}
        borderColor={borderColor}
        width={width}
        paddingX={1}
      >
        <Text aria-hidden color={value ? theme.colors.foreground : theme.colors.mutedForeground}>
          {value || placeholder}
        </Text>
        {isFocused && (
          <Text aria-hidden color={theme.colors.focusRing}>
            {cursor}
          </Text>
        )}
      </Box>
      {isFocused && completions.length > 0 && (
        <Box
          aria-role="listbox"
          flexDirection="column"
          borderStyle={resolveBorderStyle("single", unicode)}
          borderColor={theme.colors.border}
          width={width}
        >
          {completions.map((c, idx) => (
            <Box
              key={c}
              aria-label={c}
              aria-role="option"
              aria-state={{ selected: idx === completionIndex }}
              paddingX={1}
            >
              <Text
                aria-hidden
                color={
                  idx === completionIndex
                    ? theme.colors.selectionForeground
                    : theme.colors.foreground
                }
                {...(idx === completionIndex ? { backgroundColor: theme.colors.selection } : {})}
              >
                {c}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      {isFocused && completions.length > 0 && (
        <Text aria-hidden color={theme.colors.mutedForeground} dimColor>
          {resolveTerminalSymbol(
            unicode,
            "Right arrow: accept · ↑↓: navigate",
            "Right arrow: accept | up/down: navigate",
          )}
        </Text>
      )}
    </Box>
  );
};
