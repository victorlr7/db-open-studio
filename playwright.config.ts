import { defineConfig, devices } from "@playwright/test";

const e2ePort = process.env.DBOPENSTUDIO_E2E_PORT ?? "7500";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${e2ePort}`;
const webServerCommand = process.env.DBOPENSTUDIO_E2E_COMMAND ?? `npx next dev -p ${e2ePort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: webServerCommand,
    env: {
      NEXT_PUBLIC_DBOPENSTUDIO_AI_ENABLED: "",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
      NEXT_PUBLIC_SUPABASE_URL: "",
      DBOPENSTUDIO_DATABASE_URL: "",
      DBOPENSTUDIO_LOCAL_STORE_PATH: ".tmp/e2e-dbopenstudio.json",
      OPENAI_API_KEY: "",
      OPENAI_MODEL: "",
    },
    url: baseURL,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "true",
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
