import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.next/**", "**/next-env.d.ts", "**/next.config.mjs", "**/node_modules/**", ".superpowers/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
