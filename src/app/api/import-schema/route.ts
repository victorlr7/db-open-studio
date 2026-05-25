import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isSupabaseConfigured, userFromRequest } from "@/lib/auth";
import { id, nowIso } from "@/lib/defaults";
import { importPostgresSchema } from "@/lib/schema-import";
import { readDbStore, saveDbSnapshot } from "@/lib/db-store";
import { readStore, saveSnapshot } from "@/lib/store";
import type { DbColumn, DbRelation, DbTable, SchemaModel, VisualProject } from "@/lib/types";

const importSchema = z.object({
  projectId: z.string().min(1),
  mode: z.enum(["preview", "import"]).default("import"),
  connectionString: z.string().optional(),
  supabaseUrl: z.string().url().optional(),
  host: z.string().optional(),
  port: z.coerce.number().optional(),
  database: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  schema: z.string().default("public"),
  ssl: z.boolean().default(true),
  saveConnectionSettings: z.boolean().default(false),
  selectedTableKeys: z.array(z.string()).optional(),
});

function tableKey(table: Pick<DbTable, "schema" | "name">) {
  return `${table.schema}.${table.name}`;
}

function comparableTable(table: DbTable) {
  return {
    schema: table.schema,
    name: table.name,
    columns: table.columns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      primaryKey: column.primaryKey,
      unique: column.unique,
      defaultValue: column.defaultValue ?? "",
    })),
    indexes: table.indexes.map((index) => ({
      name: index.name,
      columns: index.columns,
      unique: index.unique,
      definition: index.definition ?? "",
    })),
  };
}

function tableStatus(importedTable: DbTable, currentTable?: DbTable) {
  if (!currentTable) return "new";
  return JSON.stringify(comparableTable(importedTable)) === JSON.stringify(comparableTable(currentTable))
    ? "unchanged"
    : "changed";
}

function buildPreview(currentModel: SchemaModel, importedModel: SchemaModel) {
  const currentByKey = new Map(currentModel.tables.map((table) => [tableKey(table), table]));
  return importedModel.tables.map((table) => {
    const key = tableKey(table);
    const status = tableStatus(table, currentByKey.get(key));
    return {
      key,
      schema: table.schema,
      name: table.name,
      columns: table.columns.length,
      status,
      selected: status !== "unchanged",
    };
  });
}

function normalizeImportedTable(
  importedTable: DbTable,
  currentTable: DbTable | undefined,
  tableIdMap: Map<string, string>,
  columnIdMap: Map<string, string>,
) {
  const currentColumnsByName = new Map(currentTable?.columns.map((column) => [column.name, column]) ?? []);
  const nextTableId = currentTable?.id ?? importedTable.id;
  tableIdMap.set(importedTable.id, nextTableId);

  const nextColumns: DbColumn[] = importedTable.columns.map((column) => {
    const nextColumnId = currentColumnsByName.get(column.name)?.id ?? column.id;
    columnIdMap.set(column.id, nextColumnId);
    return { ...column, id: nextColumnId };
  });

  return {
    ...importedTable,
    id: nextTableId,
    columns: nextColumns,
  };
}

function mergeImportedModel(currentModel: SchemaModel, importedModel: SchemaModel, selectedTableKeys: string[]) {
  const selected = new Set(selectedTableKeys);
  const currentByKey = new Map(currentModel.tables.map((table) => [tableKey(table), table]));
  const tableIdMap = new Map<string, string>();
  const columnIdMap = new Map<string, string>();

  importedModel.tables.forEach((importedTable) => {
    const currentTable = currentByKey.get(tableKey(importedTable));
    if (!currentTable) return;
    tableIdMap.set(importedTable.id, currentTable.id);
    importedTable.columns.forEach((column) => {
      const currentColumn = currentTable.columns.find((item) => item.name === column.name);
      if (currentColumn) columnIdMap.set(column.id, currentColumn.id);
    });
  });

  const importedSelectedTables = importedModel.tables
    .filter((table) => selected.has(tableKey(table)))
    .map((table) => normalizeImportedTable(table, currentByKey.get(tableKey(table)), tableIdMap, columnIdMap));
  const selectedImportedKeys = new Set(importedSelectedTables.map(tableKey));
  const keptCurrentTables = currentModel.tables.filter((table) => !selectedImportedKeys.has(tableKey(table)));
  const finalTables = [...keptCurrentTables, ...importedSelectedTables];
  const finalTableIds = new Set(finalTables.map((table) => table.id));
  const selectedFinalTableIds = new Set(importedSelectedTables.map((table) => table.id));

  const keptRelations = currentModel.relations.filter(
    (relation) => !selectedFinalTableIds.has(relation.fromTableId) && !selectedFinalTableIds.has(relation.toTableId),
  );
  const importedRelations: DbRelation[] = importedModel.relations
    .map((relation) => ({
      ...relation,
      fromTableId: tableIdMap.get(relation.fromTableId) ?? relation.fromTableId,
      toTableId: tableIdMap.get(relation.toTableId) ?? relation.toTableId,
      fromColumnId: columnIdMap.get(relation.fromColumnId) ?? relation.fromColumnId,
      toColumnId: columnIdMap.get(relation.toColumnId) ?? relation.toColumnId,
    }))
    .filter(
      (relation) =>
        finalTableIds.has(relation.fromTableId) &&
        finalTableIds.has(relation.toTableId) &&
        (selectedFinalTableIds.has(relation.fromTableId) || selectedFinalTableIds.has(relation.toTableId)),
    );

  return {
    version: 1,
    schemas: Array.from(new Set([...currentModel.schemas, ...importedModel.schemas])),
    tables: finalTables,
    relations: [...keptRelations, ...importedRelations],
  } satisfies SchemaModel;
}

async function readCurrentProject(authUser: Awaited<ReturnType<typeof userFromRequest>>, projectId: string): Promise<VisualProject | undefined> {
  if (authUser) {
    const store = await readDbStore(authUser);
    return store.projects.find((project) => project.id === projectId);
  }
  const store = await readStore();
  return store.projects.find((project) => project.id === projectId);
}

export async function POST(request: Request) {
  try {
    const authUser = isSupabaseConfigured() ? await userFromRequest(request) : undefined;
    const input = importSchema.parse(await request.json());
    if (!input.connectionString && !input.password) {
      return NextResponse.json(
        { error: "Necesitas una connection string o la password de Postgres/Supabase." },
        { status: 400 },
      );
    }

    const result = await importPostgresSchema(input);
    const currentProject = await readCurrentProject(authUser, input.projectId);
    if (!currentProject) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const preview = buildPreview(currentProject.model, result.model);

    if (input.mode === "preview") {
      return NextResponse.json({
        preview,
        imported: {
          tables: result.model.tables.length,
          relations: result.model.relations.length,
        },
        connection: result.connection,
      });
    }

    const selectedTableKeys = input.selectedTableKeys ?? preview.filter((table) => table.selected).map((table) => table.key);
    const mergedModel = mergeImportedModel(currentProject.model, result.model, selectedTableKeys);
    const snapshot = {
      id: authUser ? randomUUID() : id("snp"),
      name: `Import ${new Date().toLocaleString("sv-SE")}`,
      source: result.connection,
      schema: mergedModel,
      importedAt: nowIso(),
    };
    const projectConnection = input.saveConnectionSettings ? result.connection : undefined;
    const project = authUser
      ? await saveDbSnapshot(authUser, input.projectId, snapshot, projectConnection)
      : await saveSnapshot(input.projectId, snapshot, projectConnection);

    return NextResponse.json({
      project,
      snapshot,
      imported: {
        tables: result.model.tables.length,
        relations: result.model.relations.length,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "No se pudo importar el esquema." },
      { status: 400 },
    );
  }
}
