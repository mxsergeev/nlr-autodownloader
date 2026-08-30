import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AppThemeProvider from "../ThemeContext";

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 60_000 },
      mutations: { retry: false },
    },
  });
}

export function TestProviders({ children, queryClient = createTestQueryClient() }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AppThemeProvider>{children}</AppThemeProvider>
    </QueryClientProvider>
  );
}
