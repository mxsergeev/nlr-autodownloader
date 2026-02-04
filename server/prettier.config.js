/**
 * @see https://prettier.io/docs/configuration
 * @type {import("prettier").Config}
 */
const config = {
  arrowParens: "always",
  bracketSameLine: false,
  objectWrap: "preserve",
  bracketSpacing: true,
  semi: false,
  experimentalOperatorPosition: "end",
  experimentalTernaries: false,
  singleQuote: true,
  jsxSingleQuote: false,
  quoteProps: "as-needed",
  trailingComma: "all",
  singleAttributePerLine: false,
  htmlWhitespaceSensitivity: "css",
  vueIndentScriptAndStyle: false,
  proseWrap: "preserve",
  endOfLine: "lf",
  insertPragma: false,
  printWidth: 120,
  requirePragma: false,
  tabWidth: 2,
  useTabs: false,
  embeddedLanguageFormatting: "auto",
}

export default config
