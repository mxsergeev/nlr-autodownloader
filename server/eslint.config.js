import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  { ignores: ["node_modules", "dist"] },
  {
    files: ["**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      parserOptions: { sourceType: "module" },
    },
    rules: {
      "no-unused-vars": ["warn", { varsIgnorePattern: "^[A-Z_]" }],
    },
  },
]);
