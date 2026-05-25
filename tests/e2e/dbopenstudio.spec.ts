import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const e2eStorePath = path.join(process.cwd(), ".tmp", "e2e-dbopenstudio.json");

test.beforeEach(async () => {
  await fs.mkdir(path.dirname(e2eStorePath), { recursive: true });
  await fs.writeFile(
    e2eStorePath,
    JSON.stringify(
      {
        users: [
          {
            id: "local-user",
            name: "Local user",
            email: "local@dbopenstudio.dev",
            locale: "en",
          },
        ],
        projects: [],
        migrations: [],
      },
      null,
      2,
    ),
    "utf8",
  );
});

async function enterLocalMode(page: import("@playwright/test").Page) {
  await page.goto("/");
  const localButton = page.getByRole("button", { name: "Continue locally" });
  await localButton.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  if (await localButton.isVisible()) {
    await localButton.click();
  }
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor({ state: "visible", timeout: 2_000 }).catch(async () => {
    const spanishLanguage = page.getByLabel("Idioma");
    if (await spanishLanguage.isVisible()) {
      await spanishLanguage.selectOption("en");
    }
  });
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
}

test("loads without an api request loop", async ({ page }) => {
  let workspaceRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/workspace")) workspaceRequests += 1;
  });

  await enterLocalMode(page);
  await expect(page.getByRole("img", { name: "DB Open Studio" })).toBeVisible();
  await expect(page.getByTitle("Open AI")).toHaveCount(0);
  await expect(page.locator(".user-pill")).toHaveCount(0);
  await page.getByRole("button", { name: /Active user/ }).click();
  await expect(page.locator(".user-pill")).toBeVisible();
  await page.locator(".user-pill").click();
  await expect(page.locator("header").getByRole("heading", { name: "User profile" })).toBeVisible();
  await expect(page.getByRole("button", { name: "View all projects" })).toBeVisible();
  await page.getByRole("button", { name: /DB Open Studio/ }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.getByLabel("Language").selectOption("es");
  await expect(page.getByRole("heading", { name: "Proyectos", exact: true })).toBeVisible();
  await page.getByLabel("Idioma").selectOption("ca");
  await expect(page.getByRole("button", { name: "Nou projecte", exact: true })).toBeVisible();
  await page.getByLabel("Idioma").selectOption("en");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.locator(".project-list")).toHaveCount(0);
  await expect(page.locator(".table-list")).toHaveCount(0);
  await page.waitForTimeout(2500);

  expect(workspaceRequests).toBeLessThanOrEqual(4);
  await expect(page.getByText("Failed to fetch")).toHaveCount(0);
});

test("creates a project, table, migration, and portable JSON export in local mode", async ({ page }, testInfo) => {
  await enterLocalMode(page);

  const projectName = `Proyecto E2E ${Date.now()}`;
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New project" })).toBeVisible();
  await page.getByLabel("Project name").fill(projectName);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("button", { name: new RegExp(projectName) })).toBeVisible();

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText(/Save all import settings/)).toBeVisible();
  await expect(page.getByText(/Internal tables/)).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByTitle("New table").click();
  const tableNode = page.locator(".table-node").last();
  await expect(tableNode).toBeVisible();
  await expect(tableNode).toContainText("public.table_");
  await expect(page.getByTitle("Undo")).toBeEnabled();
  await page.getByTitle("Undo").click();
  await expect(page.locator(".table-node")).toHaveCount(0);
  await expect(page.getByTitle("Redo")).toBeEnabled();
  await page.getByTitle("Redo").click();
  await expect(page.locator(".table-node")).toHaveCount(1);
  await expect(page.getByText("Columns", { exact: true })).toBeVisible();
  const flowPane = page.locator(".react-flow__pane");
  const flowPaneBox = await flowPane.boundingBox();
  expect(flowPaneBox).not.toBeNull();
  await page.mouse.click(flowPaneBox!.x + 24, flowPaneBox!.y + 24);
  await expect(page.getByText("Columns", { exact: true })).toHaveCount(0);
  await tableNode.click();
  await expect(page.getByText("Columns", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Main view/ })).toBeVisible();

  const tableListItem = page.locator(".table-list-item").filter({ hasText: "table_1" }).last();
  await expect(tableListItem).toHaveClass(/table-list-item-on-canvas/);
  await tableListItem.click();
  await expect(page.locator(".table-node")).toHaveCount(0);
  await expect(tableListItem).not.toHaveClass(/table-list-item-on-canvas/);
  await tableListItem.click();
  await expect(page.locator(".table-node")).toHaveCount(1);

  await page.getByRole("button", { name: "Non-identifying 1:1 FK" }).click();
  await expect(page.getByText("Could not complete the action")).toBeVisible();
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.getByText("Could not complete the action")).toHaveCount(0);

  await page.getByRole("button", { name: "New view" }).first().click();
  await expect(page.getByRole("heading", { name: "New view" })).toBeVisible();
  await page.getByLabel("View name").fill("Items");
  await page.getByRole("button", { name: "Create view" }).click();
  await expect(page.getByRole("tab", { name: /Items/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".table-node")).toHaveCount(0);
  await page.getByTitle("New table").click();
  await expect(page.locator(".table-node")).toHaveCount(1);
  await page.getByRole("tab", { name: /Main view/ }).click();
  await expect(page.getByRole("tab", { name: /Main view/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".table-node")).toHaveCount(1);

  await page.getByTitle("New table").click();
  await expect(page.locator(".table-node")).toHaveCount(2);
  const firstNode = page.locator(".table-node").filter({ hasText: "public.table_1" }).first();
  const secondNode = page.locator(".table-node").nth(1);
  await expect(firstNode).toBeVisible();
  await expect(secondNode).toBeVisible();

  const beforeDrag = await firstNode.boundingBox();
  const secondBeforeDrag = await secondNode.boundingBox();
  expect(beforeDrag).not.toBeNull();
  expect(secondBeforeDrag).not.toBeNull();
  await page.mouse.move(beforeDrag!.x + beforeDrag!.width / 2, beforeDrag!.y + 24);
  await page.mouse.down();
  await page.mouse.move(beforeDrag!.x + beforeDrag!.width / 2 - 90, beforeDrag!.y + 70, { steps: 8 });
  const duringDrag = await firstNode.boundingBox();
  const secondDuringDrag = await secondNode.boundingBox();
  expect(duringDrag).not.toBeNull();
  expect(secondDuringDrag).not.toBeNull();
  expect(duringDrag!.x).toBeLessThan(beforeDrag!.x - 40);
  expect(Math.abs(secondDuringDrag!.x - secondBeforeDrag!.x)).toBeLessThan(2);
  expect(Math.abs(secondDuringDrag!.y - secondBeforeDrag!.y)).toBeLessThan(2);
  await page.mouse.up();

  const beforeResize = await firstNode.boundingBox();
  expect(beforeResize).not.toBeNull();
  const resizeHandle = firstNode.locator(".table-custom-resize");
  await expect(resizeHandle).toBeVisible();
  await expect(resizeHandle).toHaveCSS("cursor", "nwse-resize");
  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 120, handleBox!.y + handleBox!.height / 2 + 60, {
    steps: 8,
  });
  const duringResize = await firstNode.boundingBox();
  expect(duringResize).not.toBeNull();
  expect(duringResize!.width).toBeGreaterThan(beforeResize!.width + 80);
  await page.mouse.up();
  const afterResize = await firstNode.boundingBox();
  expect(afterResize).not.toBeNull();
  expect(afterResize!.width).toBeGreaterThan(beforeResize!.width + 80);
  expect(afterResize!.height).toBeGreaterThan(beforeResize!.height + 35);

  await firstNode.locator(".node-title").click();
  await expect(firstNode.locator(".node-column")).toHaveCount(1);
  await firstNode.getByLabel("Hide fields").click();
  await expect(firstNode.locator(".node-column")).toHaveCount(0);
  await expect(firstNode).toHaveClass(/table-node-collapsed/);
  await firstNode.getByLabel("Show fields").click();
  await expect(firstNode.locator(".node-column")).toHaveCount(1);

  await page.getByRole("button", { name: "Non-identifying 1:N FK" }).click();
  await expect(page.getByText("Select the source table for the FK")).toBeVisible();
  await firstNode.click();
  await expect(page.getByText("Select the target table for the FK")).toBeVisible();
  await secondNode.click();
  await expect(page.locator(".dbos-fk-edge")).toHaveCount(1);
  await expect(page.locator(".fk-end-label-source")).toHaveText("N");
  await expect(page.locator(".fk-end-label-target")).toHaveText("1");
  await expect(firstNode.locator(".column-marker-pk")).toBeVisible();
  await expect(firstNode.locator(".column-marker-fk")).toBeVisible();
  const edgePath = page.locator(".dbos-fk-edge-path").first();
  await expect(edgePath).toBeVisible();
  const edgePathBeforeDrag = await edgePath.getAttribute("d");
  const relationDragBox = await firstNode.locator(".node-title").boundingBox();
  expect(relationDragBox).not.toBeNull();
  await page.mouse.move(relationDragBox!.x + relationDragBox!.width / 2, relationDragBox!.y + relationDragBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(relationDragBox!.x + relationDragBox!.width / 2 + 60, relationDragBox!.y + relationDragBox!.height / 2 + 20, {
    steps: 5,
  });
  await expect(edgePath).toBeVisible();
  const edgePathDuringDrag = await edgePath.getAttribute("d");
  expect(edgePathDuringDrag).not.toEqual(edgePathBeforeDrag);
  await page.mouse.up();

  const firstNodeColumns = firstNode.locator(".node-column");
  await expect(firstNodeColumns).toHaveCount(2);
  await expect(firstNodeColumns.nth(0)).toContainText("id");
  await expect(firstNodeColumns.nth(1)).toContainText("table_3_id");
  const firstColumnBox = await firstNodeColumns.nth(0).boundingBox();
  const secondColumnBox = await firstNodeColumns.nth(1).boundingBox();
  expect(firstColumnBox).not.toBeNull();
  expect(secondColumnBox).not.toBeNull();
  await page.mouse.move(secondColumnBox!.x + secondColumnBox!.width / 2, secondColumnBox!.y + secondColumnBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstColumnBox!.x + firstColumnBox!.width / 2, firstColumnBox!.y + firstColumnBox!.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  await expect(firstNode.locator(".node-column").nth(0)).toContainText("table_3_id");
  await expect(firstNode.locator(".node-column").nth(1)).toContainText("id");

  await page.getByRole("button", { name: "Deselect" }).click();
  await expect(page.getByText("Columns", { exact: true })).toHaveCount(0);
  await firstNode.click();
  await expect(page.getByText("Columns", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Generate migration" }).first().click();
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Save and generate" }).click();
  await expect(page.locator(".migration-panel pre")).toContainText("CREATE TABLE");
  await page.getByRole("button", { name: "Migrations" }).click();
  await expect(page.getByRole("heading", { name: "Migrations" })).toBeVisible();
  await expect(page.locator(".migration-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".migration-table tbody tr").first()).toContainText("local@dbopenstudio.dev");
  await expect(page.getByRole("button", { name: "AI Description" })).toBeDisabled();
  await expect(page.getByTitle("Download migration")).toBeVisible();
  await page.getByTitle("Show in migration console").click();
  await expect(page.locator(".migration-panel pre")).toContainText("CREATE TABLE");
  await expect(page.locator(".migration-panel .sql-keyword").first()).toBeVisible();
  await expect(page.locator(".migration-panel .sql-table").first()).toBeVisible();
  const migrationPanel = page.locator(".migration-panel");
  const migrationPanelBeforeResize = await migrationPanel.boundingBox();
  expect(migrationPanelBeforeResize).not.toBeNull();
  const migrationResizeHandle = page.getByTitle("Resize migration console");
  const migrationResizeBox = await migrationResizeHandle.boundingBox();
  expect(migrationResizeBox).not.toBeNull();
  await page.mouse.move(migrationResizeBox!.x + migrationResizeBox!.width / 2, migrationResizeBox!.y + migrationResizeBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(migrationResizeBox!.x + migrationResizeBox!.width / 2, migrationResizeBox!.y + migrationResizeBox!.height / 2 - 90, {
    steps: 6,
  });
  await page.mouse.up();
  const migrationPanelAfterResize = await migrationPanel.boundingBox();
  expect(migrationPanelAfterResize).not.toBeNull();
  expect(migrationPanelAfterResize!.height).toBeGreaterThan(migrationPanelBeforeResize!.height + 60);
  await migrationPanel.getByTitle("Close").click();
  await expect(migrationPanel).toHaveCount(0);
  const projectViewsToggle = page.getByRole("button", { name: "Project views" });
  if ((await projectViewsToggle.getAttribute("aria-expanded")) !== "true") {
    await projectViewsToggle.click();
  }
  await page.locator(".view-sidebar-main").filter({ hasText: "Main view" }).click();
  await expect(page.getByTitle("Export JSON")).toBeVisible();

  const download = await Promise.all([
    page.waitForEvent("download"),
    page.getByTitle("Export JSON").click(),
  ]).then(([download]) => download);
  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();
  const exportedJson = await fs.readFile(downloadedPath!, "utf8");
  const exportPath = path.join(testInfo.outputDir, "dbopenstudio-project.json");
  await fs.mkdir(testInfo.outputDir, { recursive: true });
  await fs.writeFile(exportPath, exportedJson, "utf8");
  const exported = JSON.parse(exportedJson) as {
    format: string;
    version: number;
    project: { name: string; model: { tables: unknown[]; relations: unknown[] }; views: unknown[] };
  };
  expect(exported.format).toBe("dbopenstudio.project");
  expect(exported.version).toBe(1);
  expect(exported.project.name).toBe(projectName);
  expect(exported.project.model.tables.length).toBeGreaterThanOrEqual(2);
  expect(exported.project.model.relations.length).toBeGreaterThanOrEqual(1);
  expect(exported.project.views.length).toBeGreaterThanOrEqual(2);

  await page.setInputFiles('[data-testid="project-import-input"]', exportPath);
  await expect(page.getByRole("button", { name: new RegExp(`${projectName} - import`) })).toBeVisible();
  await expect(page.locator(".table-node")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: /Main view/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: "View all projects" }).click();
  await expect(page.locator(".project-browser-card").filter({ hasText: projectName })).toHaveCount(2);
  const importedProjectCard = page.locator(".project-browser-card").filter({ hasText: `${projectName} - import` });
  await importedProjectCard.getByTitle("Share project").click();
  await expect(page.getByRole("heading", { name: "Share project" })).toBeVisible();
  await page.getByLabel("User email").fill("missing-user@example.com");
  await page.locator(".modal").getByRole("button", { name: "Share project" }).click();
  await expect(page.getByText("That user does not exist in the system.")).toBeVisible();
  await page.getByRole("button", { name: "Got it" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await importedProjectCard.getByTitle("Delete project").click();
  await expect(page.getByRole("heading", { name: "Delete project" })).toBeVisible();
  await expect(page.getByText("This action cannot be undone.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
});
