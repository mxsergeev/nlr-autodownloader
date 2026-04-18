import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";
import eslintReact from "@eslint-react/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import eslintConfigPrettier from "eslint-config-prettier";

export default defineConfig([
  { ignores: ["node_modules", "dist"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.browser,
      parserOptions: {
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // React 17+ JSX transform — no need to import React for JSX
      "no-unused-vars": ["warn", { varsIgnorePattern: "^React$|^[A-Z_]" }],
      // Empty catch blocks are valid for silently swallowing non-critical errors
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Vite config runs in Node, not browser
    files: ["vite.config.js"],
    languageOptions: { globals: globals.node },
  },
  eslintReact.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  eslintConfigPrettier,
]);
