// Adapted from shadcn-labs/termcn (MIT). See src/cli/termcn/README.md.
import * as React from "react";

import type { Theme, ThemeContextValue } from "~/cli/termcn/components/ui/types";

import { defaultTheme } from "~/cli/termcn/lib/terminal-themes/default";

export const ThemeContext = React.createContext<ThemeContextValue>({
  setTheme: () => {
    // The default context keeps useTheme provider-optional.
  },
  theme: defaultTheme,
});

export const useTheme = (): Theme => React.useContext(ThemeContext).theme;

export const useThemeUpdater = (): ((theme: Theme) => void) =>
  React.useContext(ThemeContext).setTheme;
