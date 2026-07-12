import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.CAP_WEB_BASE_URL ?? "http://localhost:3000";
const isHosted = Boolean(process.env.CAP_WEB_BASE_URL);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: isHosted ? 1 : 0,
  timeout: 300_000,
  expect: { timeout: 180_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      grep: /@responsive/,
    },
  ],
  ...(isHosted
    ? {}
    : {
        webServer: {
          command: "pnpm dev",
          env: {
            ...process.env,
            API_PROXY_TARGET:
              process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8787",
          },
          reuseExistingServer: true,
          timeout: 120_000,
          url: baseURL,
        },
      }),
});
