/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // Run tests sequentially to avoid state pollution from parallel execution
  maxWorkers: 1,
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
    }],
    // chokidar 5+ and its dependency readdirp 5+ ship ES modules only. Jest
    // runs CommonJS here and by default does not transform node_modules, so
    // importing them fails with "Cannot use import statement outside a
    // module". Compile these two packages to CommonJS for the tests.
    // Node itself loads them with require() (Node >= 22.12), which the CI
    // step "Load the built watcher" checks against the real build.
    'node_modules[\\\\/](chokidar|readdirp)[\\\\/].+\\.js$': ['ts-jest', {
      tsconfig: {
        allowJs: true,
        module: 'commonjs',
        moduleResolution: 'node',
        target: 'ES2022',
        esModuleInterop: true,
        isolatedModules: true,
      },
      diagnostics: false,
    }],
  },
  transformIgnorePatterns: ['node_modules[\\\\/](?!(chokidar|readdirp)[\\\\/])'],
  extensionsToTreatAsEsm: ['.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/cli/**',
    '!src/**/*.d.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
};
