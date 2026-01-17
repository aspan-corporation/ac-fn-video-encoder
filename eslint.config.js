// eslint.config.js
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import tseslint from "typescript-eslint";

export default [
  // Flat config doesn't require explicit 'extends' for base rules
  ...tseslint.configs.recommended,
  eslintPluginPrettierRecommended, // Automatically sets up "prettier/prettier" rule and integrates
  {
    // Define files to apply this config to
    files: ["*.ts"],
    // Optional: add project-specific ignores here
    // ignores: ["dist/"]
  },
];
