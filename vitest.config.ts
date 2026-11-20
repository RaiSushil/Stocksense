import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so tests run without the React Router plugin.
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "file:./test.sqlite",
      SHOPIFY_API_KEY: "test-key",
      SHOPIFY_API_SECRET: "test-secret",
      SHOPIFY_APP_URL: "https://stocksense.test",
      SCOPES: "read_products",
      DISABLE_SCHEDULER: "true",
    },
    globalSetup: ["./app/test/global-setup.ts"],
  },
});
