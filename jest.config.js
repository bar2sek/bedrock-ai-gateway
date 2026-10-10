module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest']
  },
  setupFiles: ['<rootDir>/test/setup.ts'],
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
