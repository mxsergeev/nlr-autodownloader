import React, { createContext, useContext, useMemo, useState } from "react";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";

const ColorModeContext = createContext({ toggleColorMode: () => {}, mode: "dark" });

export const useColorMode = () => useContext(ColorModeContext);

const getDesignTokens = (mode) => ({
  palette: {
    mode,
    ...(mode === "dark"
      ? {
          primary: { main: "#7c9eff" },
          background: { default: "#0f1117", paper: "#181c27" },
          divider: "rgba(255,255,255,0.08)",
          text: { primary: "#e8ecf4", secondary: "#8b93a7" },
        }
      : {
          primary: { main: "#3d5afe" },
          background: { default: "#f4f6fb", paper: "#ffffff" },
          divider: "rgba(0,0,0,0.08)",
          text: { primary: "#111827", secondary: "#6b7280" },
        }),
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: '"Inter", "Roboto", -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    h5: { fontWeight: 700, letterSpacing: "-0.02em" },
    body2: { letterSpacing: "0.01em" },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        "*, *::before, *::after": { boxSizing: "border-box" },
        body: { transition: "background-color 0.2s ease, color 0.2s ease" },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: "none" },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          fontWeight: 600,
          letterSpacing: "0.01em",
        },
        containedPrimary: ({ theme }) => ({
          boxShadow: "none",
          "&:hover": {
            boxShadow: `0 4px 14px ${theme.palette.primary.main}55`,
          },
        }),
      },
    },
    MuiTextField: {
      defaultProps: { size: "small" },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: ({ theme }) => ({
          transition: "box-shadow 0.2s ease",
          "&.Mui-focused": {
            boxShadow: `0 0 0 3px ${theme.palette.primary.main}33`,
          },
        }),
      },
    },
    MuiListItem: {
      styleOverrides: {
        root: ({ theme }) => ({
          borderRadius: theme.shape.borderRadius,
          "&:hover": {
            backgroundColor: theme.palette.action?.hover,
          },
        }),
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 500, letterSpacing: "0.02em" },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 10 },
      },
    },
  },
});

export default function AppThemeProvider({ children }) {
  const [mode, setMode] = useState(() => {
    try {
      return localStorage.getItem("colorMode") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });

  const colorMode = useMemo(
    () => ({
      mode,
      toggleColorMode: () => {
        setMode((prev) => {
          const next = prev === "dark" ? "light" : "dark";
          try {
            localStorage.setItem("colorMode", next);
          } catch {}
          return next;
        });
      },
    }),
    [mode]
  );

  const theme = useMemo(() => createTheme(getDesignTokens(mode)), [mode]);

  return (
    <ColorModeContext.Provider value={colorMode}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ColorModeContext.Provider>
  );
}
