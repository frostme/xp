// Adapted from shadcn-labs/termcn (MIT). See src/cli/termcn/README.md.
import { Box, Text } from "ink";
import { useRef, useState } from "react";

import { useInteraction } from "~/cli/termcn/hooks/use-interaction";
import { useTheme } from "~/cli/termcn/hooks/use-theme";
import { useUnicode } from "~/cli/termcn/hooks/use-unicode";
import { resolveTerminalSymbol } from "~/cli/termcn/lib/terminal-symbols";

export interface SelectOption<T = string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface SelectProps<T = string> {
  options: SelectOption<T>[];
  maxVisible?: number;
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  onChange?: (value: T) => void;
  onSubmit?: (value: T) => void;
  label?: string;
  cursor?: string;
  cursorColor?: string;
  id?: string;
  autoFocus?: boolean;
  isActive?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
}

export const Select = <T = string,>({
  options,
  maxVisible = 8,
  value: controlledValue,
  defaultValue,
  onValueChange,
  onChange,
  onSubmit,
  label,
  cursor,
  cursorColor,
  id,
  autoFocus = false,
  isActive = true,
  disabled = false,
  "aria-label": ariaLabel,
}: SelectProps<T>) => {
  const theme = useTheme();
  const unicode = useUnicode();
  const resolvedCursor = cursor ?? resolveTerminalSymbol(unicode, "›", ">");
  const selectedIndicator = resolveTerminalSymbol(unicode, "✓", "*");
  const firstEnabledIndex = Math.max(
    0,
    options.findIndex((option) => !option.disabled),
  );
  const [activeIndex, setActiveIndex] = useState(() => {
    const selectedIndex = options.findIndex(
      (option) => !option.disabled && option.value === (controlledValue ?? defaultValue),
    );
    return selectedIndex < 0 ? firstEnabledIndex : selectedIndex;
  });
  // Input events from a single terminal read can arrive before React commits.
  const cursorRef = useRef(activeIndex);
  const moveCursor = (update: number | ((index: number) => number)) => {
    cursorRef.current = typeof update === "function" ? update(cursorRef.current) : update;
    setActiveIndex(cursorRef.current);
  };
  const [internalValue, setInternalValue] = useState(defaultValue);
  const selectedValue = controlledValue ?? internalValue;

  const resolvedCursorColor = cursorColor ?? theme.colors.primary;

  const { isFocused } = useInteraction(
    (_input, key) => {
      if (key.upArrow) {
        moveCursor((i) => {
          let next = i - 1;
          while (next >= 0 && options[next]?.disabled) {
            next -= 1;
          }
          return next < 0 ? i : next;
        });
      } else if (key.downArrow) {
        moveCursor((i) => {
          let next = i + 1;
          while (next < options.length && options[next]?.disabled) {
            next += 1;
          }
          return next >= options.length ? i : next;
        });
      } else if (key.home) {
        moveCursor(firstEnabledIndex);
      } else if (key.end) {
        const lastEnabledIndex = options.findLastIndex((option) => !option.disabled);
        if (lastEnabledIndex !== -1) {
          moveCursor(lastEnabledIndex);
        }
      } else if (key.return) {
        const opt = options[cursorRef.current];
        if (opt && !opt.disabled) {
          if (controlledValue === undefined) {
            setInternalValue(opt.value);
          }
          (onValueChange ?? onChange)?.(opt.value);
          onSubmit?.(opt.value);
        }
      }
    },
    { autoFocus, disabled, id, isActive },
  );

  const visibleStart = Math.max(0, activeIndex - maxVisible + 1);

  return (
    <Box
      aria-label={ariaLabel ?? label ?? "Select"}
      aria-role="listbox"
      aria-state={{ disabled }}
      flexDirection="column"
    >
      {label && (
        <Text aria-label={ariaLabel ?? label} bold>
          {label}
        </Text>
      )}
      {options.slice(visibleStart, visibleStart + maxVisible).map((opt, visibleIndex) => {
        const idx = visibleStart + visibleIndex;
        const isActive = idx === activeIndex;
        const isSelected = selectedValue !== undefined && opt.value === selectedValue;

        let optColor: string;
        if (opt.disabled) {
          optColor = theme.colors.mutedForeground;
        } else if (isActive) {
          optColor = resolvedCursorColor;
        } else {
          optColor = theme.colors.foreground;
        }

        return (
          <Box
            key={idx}
            aria-label={opt.hint ? `${opt.label}: ${opt.hint}` : opt.label}
            aria-role="option"
            aria-state={{ disabled: Boolean(opt.disabled), selected: isSelected }}
            gap={1}
          >
            <Text
              aria-hidden
              color={isActive && isFocused ? resolvedCursorColor : theme.colors.foreground}
            >
              {isActive ? resolvedCursor : " "}
            </Text>
            {isSelected && (
              <Text aria-hidden color={theme.colors.primary}>
                {selectedIndicator}
              </Text>
            )}
            <Text
              aria-hidden
              color={optColor}
              bold={isActive || isSelected}
              dimColor={Boolean(opt.disabled)}
            >
              {opt.label}
            </Text>
            {opt.hint && (
              <Text aria-hidden color={theme.colors.mutedForeground} dimColor>
                {opt.hint}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
};
