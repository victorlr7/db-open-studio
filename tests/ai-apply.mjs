import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { applyAiChanges } = jiti("../src/lib/ai-changes.ts");
const { createTable, emptyCanvas } = jiti("../src/lib/defaults.ts");

function projectWithTables(tables) {
  return {
    id: "prj_test",
    userId: "usr_test",
    name: "Test project",
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
}

const { table: address } = createTable("address");
const partialProject = projectWithTables([address]);
const partialResult = applyAiChanges(partialProject, [
  {
    type: "add_column",
    tableName: "public.address",
    column: { name: "country_id", type: "uuid" },
  },
  {
    type: "add_relation",
    fromTableName: "address",
    fromColumnName: "country_id",
    toTableName: "country",
    toColumnName: "id",
  },
]);

assert.equal(partialResult.committed, false);
assert.equal(partialResult.project, partialProject);
assert.equal(partialResult.project.model.tables[0].columns.some((column) => column.name === "country_id"), false);
assert.equal(partialResult.project.model.relations.length, 0);
assert.equal(partialResult.skipped.length, 1);

const { table: campaign } = createTable("marketing_campaign");
const validProject = projectWithTables([campaign]);
const validResult = applyAiChanges(validProject, [
  {
    type: "add_table",
    schema: "public",
    name: "country",
  },
  {
    type: "add_relation",
    fromTableName: "public.marketing_campaign",
    fromColumnName: "country_id",
    toTableName: "public.country",
    toColumnName: "id",
    cardinality: "one-to-many",
    onDelete: "set null",
  },
]);

const country = validResult.project.model.tables.find((table) => table.name === "country");
const updatedCampaign = validResult.project.model.tables.find((table) => table.name === "marketing_campaign");

assert.equal(validResult.committed, true);
assert.equal(validResult.skipped.length, 0);
assert.ok(country);
assert.ok(updatedCampaign?.columns.some((column) => column.name === "country_id"));
assert.equal(validResult.project.model.relations.length, 1);
assert.equal(validResult.project.model.relations[0].toTableId, country.id);

const { table: orphanAddress } = createTable("address");
orphanAddress.columns.push({
  id: "col_orphan_country",
  name: "country_id",
  type: "uuid",
  nullable: true,
  primaryKey: false,
  unique: false,
});
const repairProject = projectWithTables([orphanAddress]);
const repairResult = applyAiChanges(repairProject, [
  {
    type: "add_table",
    schema: "public",
    name: "country",
  },
  {
    type: "add_relation",
    fromTableName: "address",
    fromColumnName: "country_id",
    toTableName: "country",
    toColumnName: "id",
    cardinality: "one-to-many",
  },
]);
const repairedAddress = repairResult.project.model.tables.find((table) => table.name === "address");

assert.equal(repairResult.committed, true);
assert.equal(repairResult.skipped.length, 0);
assert.equal(repairedAddress?.columns.filter((column) => column.name === "country_id").length, 1);
assert.equal(repairResult.project.model.relations.length, 1);
assert.equal(repairResult.project.model.relations[0].fromColumnId, "col_orphan_country");
