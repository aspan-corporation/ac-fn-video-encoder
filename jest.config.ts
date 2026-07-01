/*
 * For a detailed explanation regarding each configuration property and type check, visit:
 * https://jestjs.io/docs/configuration
 */

export default {
  transform: {
    "^.+\\.ts?$": "ts-jest",
  },
  // Source uses NodeNext ESM imports with explicit `.js` extensions. Strip the
  // extension so ts-jest resolves them to the sibling `.ts` files under Jest.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  clearMocks: true,
  collectCoverage: true,
  coverageDirectory: "coverage",
  coverageProvider: "v8",
  // Only unit-test our own source; skip the CDK stack template stub.
  testMatch: ["**/src/**/*.test.ts"],
};
