import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildMigrationReviewInput } = jiti("../src/lib/migration-ai-context.ts");
const { createTable, emptyCanvas } = jiti("../src/lib/defaults.ts");

const tables = Array.from({ length: 120 }, (_, index) => {
  const { table } = createTable(`table_${index}`);
  table.columns.push(
    ...Array.from({ length: 60 }, (_unused, columnIndex) => ({
      id: `col_${index}_${columnIndex}`,
      name: `column_${columnIndex}`,
      type: "text",
      nullable: true,
      primaryKey: false,
      unique: false,
    })),
  );
  return table;
});

const project = {
  id: "prj_large",
  userId: "usr_test",
  name: "Large project",
  description: "A large project used to test compact AI context.",
  aiContext: "Business context ".repeat(200),
  model: {
    version: 1,
    schemas: ["public"],
    tables,
    relations: [],
  },
  canvas: emptyCanvas(),
  createdAt: "2026-05-25T00:00:00.000Z",
  updatedAt: "2026-05-25T00:00:00.000Z",
};

const migration = {
  id: "mig_large",
  userId: "usr_test",
  projectId: "prj_large",
  name: "Large migration",
  sql: `-- start\n${"ALTER TABLE public.example ADD COLUMN country_id uuid;\n".repeat(1200)}-- end`,
  warnings: [],
  summary: {
    counts: { added_column: 120 },
    items: tables.map((table) => ({
      type: "added_column",
      table,
      column: {
        id: `new_${table.id}`,
        name: "country_id",
        type: "uuid",
        nullable: true,
        primaryKey: false,
        unique: false,
      },
    })),
  },
  createdAt: "2026-05-25T00:00:00.000Z",
};

const input = buildMigrationReviewInput(project, migration);
const serialized = JSON.stringify(input);

assert.equal(input.project.modelCounts.tables, 120);
assert.equal(input.migration.sqlTruncated, true);
assert.ok(input.migration.sql.length < migration.sql.length);
assert.ok(serialized.length < 75_000);
assert.equal(input.affectedTables.length, 120);
assert.equal("columns" in input.affectedTables[0], false);
