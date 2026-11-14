import type { ReactNode } from "react";

// Adapted from shadcn-labs/termcn (MIT). See src/cli/termcn/README.md.
import { Box, Text } from "ink";

import { useTheme } from "~/cli/termcn/hooks/use-theme";
import { useUnicode } from "~/cli/termcn/hooks/use-unicode";
import { resolveStatusSymbol } from "~/cli/termcn/lib/terminal-symbols";

import { Spinner } from "./spinner";

export type StatusVariant = "success" | "error" | "warning" | "info" | "loading" | "pending";

export interface StatusMessageProps {
  variant?: StatusVariant;
  children: ReactNode;
  icon?: string;
  "aria-label"?: string;
}

export const StatusMessage = ({
  variant = "info",
  children,
  icon,
  "aria-label": ariaLabel,
}: StatusMessageProps) => {
  const theme = useTheme();
  const unicode = useUnicode();

  const variantColor = (() => {
    switch (variant) {
      case "success": {
        return theme.colors.success;
      }
      case "error": {
        return theme.colors.error;
      }
      case "warning": {
        return theme.colors.warning;
      }
      case "loading": {
        return theme.colors.primary;
      }
      case "pending": {
        return theme.colors.muted;
      }
      default: {
        return theme.colors.info;
      }
    }
  })();

  return (
    <Box gap={1} flexDirection="row">
      <Text aria-label={ariaLabel ?? `${variant} status`}>{""}</Text>
      <Box flexShrink={0}>
        {variant === "loading" ? (
          <Spinner type="dots" color={variantColor} aria-label="Loading" />
        ) : (
          <Text aria-hidden color={variantColor}>
            {icon ?? resolveStatusSymbol(unicode, variant as Exclude<StatusVariant, "loading">)}
          </Text>
        )}
      </Box>
      <Box flexBasis={0} flexGrow={1} minWidth={0}>
        <Text>{children}</Text>
      </Box>
    </Box>
  );
};
