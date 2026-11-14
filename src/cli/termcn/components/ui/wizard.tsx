import type { ReactNode } from "react";

// Adapted from shadcn-labs/termcn (MIT). See src/cli/termcn/README.md.
import { Box, Text } from "ink";
import { useState } from "react";

import type { InteractionProps } from "~/cli/termcn/hooks/use-interaction";

import { isActivationKey, useInteraction } from "~/cli/termcn/hooks/use-interaction";
import { useTheme } from "~/cli/termcn/hooks/use-theme";
import { useUnicode } from "~/cli/termcn/hooks/use-unicode";
import { resolveStatusSymbol, resolveTerminalSymbol } from "~/cli/termcn/lib/terminal-symbols";

export interface WizardStep {
  key: string;
  title: string;
  content: ReactNode;
  validate?: () => boolean | string;
}

export interface WizardProps extends InteractionProps {
  steps: WizardStep[];
  activeStep?: number;
  onStepChange?: (step: number) => void;
  completionLabel?: string;
  compact?: boolean;
  showNavigation?: boolean;
  onComplete?: (completedSteps: string[]) => void;
  onCancel?: () => void;
  showProgress?: boolean;
  "aria-label"?: string;
}

export const Wizard = ({
  steps,
  activeStep,
  onStepChange,
  completionLabel = "Finish",
  compact = false,
  showNavigation = true,
  onComplete,
  onCancel,
  showProgress = true,
  id,
  autoFocus,
  isActive,
  disabled,
  "aria-label": ariaLabel = "Wizard",
}: WizardProps) => {
  const theme = useTheme();
  const unicode = useUnicode();
  const [internalStep, setInternalStep] = useState(0);
  const currentStep = activeStep ?? internalStep;
  const setCurrentStep = (step: number) => {
    if (activeStep === undefined) setInternalStep(step);
    onStepChange?.(step);
  };
  const [validationError, setValidationError] = useState<string | null>(null);

  const isLast = currentStep === steps.length - 1;
  const isFirst = currentStep === 0;

  const goForward = () => {
    const step = steps[currentStep];
    if (step?.validate) {
      const result = step.validate();
      if (result !== true) {
        setValidationError(typeof result === "string" ? result : "Validation failed");
        return;
      }
    }
    setValidationError(null);
    if (isLast) {
      onComplete?.(steps.map((wizardStep) => wizardStep.key));
    } else {
      setCurrentStep(currentStep + 1);
    }
  };

  const { isFocused } = useInteraction(
    (input, key) => {
      if (key.escape) {
        onCancel?.();
        return;
      }

      const goNext = key.rightArrow || isActivationKey(input, key);
      const goBack = key.leftArrow;

      if (goNext) {
        goForward();
      } else if (goBack) {
        setValidationError(null);
        if (!isFirst) {
          setCurrentStep(currentStep - 1);
        }
      }
    },
    { autoFocus, disabled, id, isActive },
  );

  return (
    <Box
      flexDirection="column"
      gap={1}
      aria-role="list"
      aria-state={{ disabled: Boolean(disabled) }}
    >
      <Text
        aria-label={`${ariaLabel}. Step ${currentStep + 1} of ${steps.length}: ${steps[currentStep]?.title ?? "Unknown"}.`}
      >
        {""}
      </Text>
      {showProgress && (
        <Box flexDirection="row" alignItems="center">
          {steps.map((step, index) => {
            if (compact && index !== currentStep) return null;
            const isCompleted = index < currentStep;
            const isCurrent = index === currentStep;

            let icon: string;
            let iconColor: string;
            if (isCompleted) {
              icon = resolveTerminalSymbol(unicode, "●", "[x]");
              iconColor = theme.colors.success;
            } else if (isCurrent) {
              icon = resolveTerminalSymbol(unicode, "◉", "[*]");
              iconColor = theme.colors.primary;
            } else {
              icon = resolveTerminalSymbol(unicode, "○", "[ ]");
              iconColor = theme.colors.mutedForeground;
            }

            return (
              <Box
                key={step.key}
                flexDirection="row"
                alignItems="center"
                aria-role="listitem"
                aria-label={`${step.title}, ${isCompleted ? "completed" : isCurrent ? "current" : "upcoming"}`}
              >
                <Text color={iconColor} bold={isCurrent}>
                  {icon} {step.title}
                </Text>
                {!compact && index < steps.length - 1 && (
                  <Text color={theme.colors.mutedForeground}>{unicode ? " ─── " : " --- "}</Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      <Box flexDirection="column" gap={1}>
        {steps[currentStep]?.content}
      </Box>

      {validationError && (
        <Text color={theme.colors.error} aria-label={`Error: ${validationError}`}>
          <Text aria-hidden>{resolveStatusSymbol(unicode, "error")} </Text>
          {validationError}
        </Text>
      )}

      {showNavigation && (
        <Box flexDirection="row" gap={2} aria-role="toolbar">
          {!isFirst && (
            <Box aria-role="button" aria-label="Back">
              <Text color={theme.colors.mutedForeground}>
                [{resolveTerminalSymbol(unicode, "←", "<-")} Back]
              </Text>
            </Box>
          )}
          {isLast ? (
            <Box aria-role="button" aria-label={completionLabel}>
              <Text color={theme.colors.primary} bold inverse={isFocused}>
                [{completionLabel}]
              </Text>
            </Box>
          ) : (
            <Box aria-role="button" aria-label="Next">
              <Text color={theme.colors.primary} bold inverse={isFocused}>
                [Next {resolveTerminalSymbol(unicode, "→", "->")}]
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};
