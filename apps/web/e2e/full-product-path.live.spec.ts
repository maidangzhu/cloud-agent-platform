import { expect, test, type Page } from "@playwright/test";

const LIVE_ENABLED = process.env.CAP_E2E_LIVE === "1";
const PASSWORD = "CapE2E-Valid1!";

test.describe("Full product path", () => {
  test.skip(!LIVE_ENABLED, "Set CAP_E2E_LIVE=1 to run hosted product tests");
  test.afterEach(async ({ page }) => cleanupWorkspaces(page));

  test("@live completes tools, evidence, usage, artifact, and refresh recovery", async ({
    page,
  }) => {
    await signUp(page, "success");

    const prompt = [
      `Full product E2E ${Date.now()}.`,
      "Use web_search to find one official OpenAI source.",
      "Use write_file to save a concise markdown summary to reports/full-product-e2e.md.",
      "Use create_artifact for that file.",
      "Execute the tools before the final answer.",
    ].join(" ");
    await startRun(page, prompt);
    await openRunActivity(page);

    await expect(completedTool(page, "web_search")).toBeVisible();
    await expect(completedTool(page, "write_file")).toBeVisible();
    await expect(page.locator('[data-event-type="run_completed"]')).toBeVisible();
    await expect(page.getByTestId("artifact-preview").first()).toBeVisible();
    await expect(page.getByTestId("run-sources")).toBeVisible();
    await expect(page.getByTestId("run-usage")).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await openRunActivity(page);
    await expect(page.locator('[data-event-type="run_completed"]')).toBeVisible();
    await expect(page.getByTestId("artifact-preview").first()).toBeVisible();
    await expect(page.getByTestId("run-sources")).toBeVisible();
    await expect(page.getByTestId("run-usage")).toBeVisible();

  });

  test("@live cancels an active run and recovers cancellation after refresh", async ({
    page,
  }) => {
    await signUp(page, "cancel");
    await startRun(
      page,
      `Cancellation E2E ${Date.now()}: reason carefully and produce a long answer about distributed systems.`,
    );

    const cancel = page.getByRole("button", { name: "Cancel run" });
    await expect(cancel).toBeEnabled();
    await cancel.click();
    await openRunActivity(page);
    await expect(page.locator('[data-event-type="run_cancelled"]')).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await openRunActivity(page);
    await expect(page.locator('[data-event-type="run_cancelled"]')).toBeVisible();

  });

  test("@live shows an explicit runtime tool failure instead of false completion", async ({
    page,
  }) => {
    await signUp(page, "failure");
    await startRun(
      page,
      `Failure E2E ${Date.now()}: use run_command with the exact command sudo whoami. Do not use another tool.`,
    );
    await openRunActivity(page);

    await expect(
      page.locator(
        '[data-testid="tool-call"][data-tool-name="run_command"][data-tool-status="failed"]',
      ).first(),
    ).toBeVisible();
    await expect(page.locator('[data-event-type="run_failed"]')).toBeVisible();
    await expect(page.locator('[data-event-type="run_completed"]')).toHaveCount(0);

  });

  test("@responsive auth and empty composer remain usable on mobile", async ({ page }) => {
    await signUp(page, "mobile");
    await expect(
      page.getByPlaceholder("Ask what to research next...", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Start run" })).toBeDisabled();
  });
});

async function signUp(page: Page, suffix: string) {
  const email = `cap-e2e-${suffix}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}@example.test`;
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Need an account? Create one" }).click();
  await page.getByPlaceholder("Name", { exact: true }).fill("CAP E2E");
  await page.getByPlaceholder("Email", { exact: true }).fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByPlaceholder("Ask what to research next...", { exact: true }),
  ).toBeVisible();
}

async function startRun(page: Page, prompt: string) {
  const composer = page.getByPlaceholder("Ask what to research next...", {
    exact: true,
  });
  await composer.fill(prompt);
  await expect(page.getByRole("button", { name: "Start run" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Cancel run" })).toBeEnabled();
}

async function openRunActivity(page: Page) {
  const toggle = page.getByTestId("run-activity-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
}

function completedTool(page: Page, name: string) {
  return page
    .locator(
      `[data-testid="tool-call"][data-tool-name="${name}"][data-tool-status="completed"]`,
    )
    .first();
}

async function cleanupWorkspaces(page: Page) {
  const request = page.context().request;
  const response = await request.get("/api/workspaces");
  if (!response.ok()) return;
  const body = (await response.json()) as {
    data?: { workspaces?: Array<{ id: string }> };
  };
  await Promise.all(
    (body.data?.workspaces ?? []).map((workspace) =>
      request.delete(`/api/workspaces/${workspace.id}`),
    ),
  );
}
