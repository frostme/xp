import type { DOMElement } from "ink";
import type { ReactNode } from "react";

// Adapted from shadcn-labs/termcn (MIT). See src/cli/termcn/README.md.
import { Box, Text, measureElement, useStdout } from "ink";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { InteractionProps } from "~/cli/termcn/hooks/use-interaction";

import { useInteraction } from "~/cli/termcn/hooks/use-interaction";
import { useTheme } from "~/cli/termcn/hooks/use-theme";
import { useUnicode } from "~/cli/termcn/hooks/use-unicode";

export interface ScrollViewProps extends InteractionProps {
  height: number;
  children: ReactNode;
  contentHeight?: number;
  showScrollbar?: boolean;
  scrollbarColor?: string;
  thumbColor?: string;
  trackChar?: string;
  thumbChar?: string;
  "aria-label"?: string;
}

export const ScrollView = ({
  height,
  children,
  contentHeight,
  showScrollbar = true,
  scrollbarColor,
  thumbColor,
  trackChar,
  thumbChar,
  id,
  autoFocus,
  isActive,
  disabled,
  "aria-label": ariaLabel = "Scrollable content",
}: ScrollViewProps) => {
  const { stdout } = useStdout();
  const [, resize] = useState(0);
  useEffect(() => {
    const onResize = () => resize((version) => version + 1);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  const contentRef = useRef<DOMElement>(null);
  const [measuredHeight, setMeasuredHeight] = useState(0);
  useLayoutEffect(() => {
    if (contentRef.current) {
      const measured = measureElement(contentRef.current).height;
      setMeasuredHeight((current) => (current === measured ? current : measured));
    }
  });
  const resolvedHeight = contentHeight ?? measuredHeight;
  const theme = useTheme();
  const unicode = useUnicode();
  const resolvedTrackChar = trackChar ?? (unicode ? "│" : "|");
  const resolvedThumbChar = thumbChar ?? (unicode ? "█" : "#");
  const [scrollTop, setScrollTop] = useState(0);

  const resolvedTrackColor = scrollbarColor ?? theme.colors.mutedForeground;
  const resolvedThumbColor = thumbColor ?? theme.colors.primary;

  const maxScroll = Math.max(0, resolvedHeight - height);

  const clampedScroll = Math.min(scrollTop, maxScroll);

  const { isFocused } = useInteraction(
    (_input, key) => {
      if (key.upArrow) {
        setScrollTop((s) => Math.max(0, s - 1));
      } else if (key.downArrow) {
        setScrollTop((s) => Math.min(maxScroll > 0 ? maxScroll : s + 1, s + 1));
      } else if (key.pageUp) {
        setScrollTop((s) => Math.max(0, s - height));
      } else if (key.pageDown) {
        setScrollTop((s) => (maxScroll > 0 ? Math.min(maxScroll, s + height) : s + height));
      } else if (key.home) {
        setScrollTop(0);
      } else if (key.end && maxScroll > 0) {
        setScrollTop(maxScroll);
      }
    },
    { autoFocus, disabled, id, isActive },
  );

  const thumbSize = useMemo(() => {
    if (resolvedHeight <= height) {
      return height;
    }
    return Math.max(1, Math.round((height / resolvedHeight) * height));
  }, [resolvedHeight, height]);

  const thumbPosition = useMemo(() => {
    if (resolvedHeight <= height || maxScroll === 0) {
      return 0;
    }
    return Math.round((clampedScroll / maxScroll) * (height - thumbSize));
  }, [clampedScroll, maxScroll, height, thumbSize, resolvedHeight]);

  const scrollbar = useMemo(
    () =>
      Array.from({ length: height }, (_, i) => {
        const isThumb = i >= thumbPosition && i < thumbPosition + thumbSize;
        return {
          char: isThumb ? resolvedThumbChar : resolvedTrackChar,
          isThumb,
        };
      }),
    [height, resolvedThumbChar, resolvedTrackChar, thumbPosition, thumbSize],
  );

  return (
    <Box
      flexDirection="row"
      width="100%"
      alignItems="flex-start"
      height={height}
      flexShrink={0}
      overflow="hidden"
      aria-role="list"
      aria-state={{ disabled: Boolean(disabled) }}
    >
      <Text
        aria-label={`${ariaLabel}. Line ${clampedScroll + 1} of ${Math.max(height, resolvedHeight)}.${isFocused ? " Focused." : ""}`}
      >
        {""}
      </Text>
      <Box
        ref={contentRef}
        flexShrink={1}
        flexBasis={0}
        minWidth={0}
        flexGrow={1}
        flexDirection="column"
        marginTop={-clampedScroll}
      >
        {children}
      </Box>
      {showScrollbar && (
        <Box aria-hidden flexShrink={0} width={1} flexDirection="column">
          {scrollbar.map((seg, i) => (
            <Text key={i} color={seg.isThumb ? resolvedThumbColor : resolvedTrackColor}>
              {seg.char}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
};
