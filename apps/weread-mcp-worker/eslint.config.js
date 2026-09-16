import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: { "no-undef": "off" },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        Response: "readonly",
      },
    },
  },
  { ignores: ["dist", "coverage", "node_modules", ".selftest-build"] },
);
