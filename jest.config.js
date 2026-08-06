/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "js"],
  collectCoverageFrom: ["src/**/*.ts"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov"],
  coverageThreshold: {
    global: {
      lines: 75,
      branches: 65,
      functions: 75,
      statements: 75,
    },
  },
  moduleNameMapper: {
    "^vscode$": "<rootDir>/__mocks__/vscode.ts",
    "^../package.json$": "<rootDir>/package.json",
  },
};
