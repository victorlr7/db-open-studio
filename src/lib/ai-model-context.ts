import type { DbColumn, DbIndex, DbRelation, DbTable, VisualProject } from "./types";

export type AiContextLevel = "manifest" | "table_details" | "all_tables_columns" | "full_compact_model";

export type AiContextPlan = {
  intent: "answer" | "propose_changes";
  contextLevel: AiContextLevel;
  tablesNeeded: string[];
  reason?: string;
};

function tableRef(table: DbTable) {
  return `${table.schema}.${table.name}`;
}

function compactColumn(column: DbColumn) {
  return {
    id: column.id,
    name: column.name,
    type: column.type,
    pk: column.primaryKey || undefined,
    unique: column.unique || undefined,
    nullable: column.nullable || undefined,
    default: column.defaultValue,
  };
}

function compactIndex(index: DbIndex) {
  return {
    name: index.name,
    columns: index.columns,
    unique: index.unique || undefined,
    method: index.definition?.match(/\bUSING\s+([a-zA-Z0-9_]+)/i)?.[1]?.toLowerCase(),
    partial: index.definition?.match(/\bWHERE\s+(.+)$/i)?.[1]?.replace(/;$/, "").trim(),
  };
}

function relationRef(relation: DbRelation, tablesById: Map<string, DbTable>, columnsById: Map<string, DbColumn>) {
  const fromTable = tablesById.get(relation.fromTableId);
  const toTable = tablesById.get(relation.toTableId);
  const fromColumn = columnsById.get(relation.fromColumnId);
  const toColumn = columnsById.get(relation.toColumnId);
  return {
    id: relation.id,
    name: relation.name,
    from: fromTable && fromColumn ? `${tableRef(fromTable)}.${fromColumn.name}` : relation.fromColumnId,
    to: toTable && toColumn ? `${tableRef(toTable)}.${toColumn.name}` : relation.toColumnId,
    cardinality: relation.cardinality,
    identifying: relation.identifying || undefined,
    onDelete: relation.onDelete,
    onUpdate: relation.onUpdate,
  };
}

function modelIndexes(project: VisualProject) {
  const tablesById = new Map(project.model.tables.map((table) => [table.id, table]));
  const columnsById = new Map(project.model.tables.flatMap((table) => table.columns.map((column) => [column.id, column] as const)));
  return { tablesById, columnsById };
}

function resolveTables(project: VisualProject, requested: string[]) {
  const normalizedRequested = requested.map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!normalizedRequested.length) return [];

  const result = new Map<string, DbTable>();
  project.model.tables.forEach((table) => {
    const candidates = [table.id, table.name, tableRef(table)].map((value) => value.toLowerCase());
    if (normalizedRequested.some((requestedValue) => candidates.includes(requestedValue))) {
      result.set(table.id, table);
    }
  });
  return Array.from(result.values());
}

function projectSummary(project: VisualProject, selectedTableId?: string) {
  const selectedTable = selectedTableId ? project.model.tables.find((table) => table.id === selectedTableId) : undefined;
  return {
    name: project.name,
    description: project.description,
    selectedTable: selectedTable ? { id: selectedTable.id, ref: tableRef(selectedTable) } : undefined,
    counts: {
      tables: project.model.tables.length,
      relations: project.model.relations.length,
      indexes: project.model.tables.reduce((count, table) => count + table.indexes.length, 0),
    },
  };
}

export function buildAiPlannerContext(project: VisualProject, selectedTableId?: string) {
  const { tablesById, columnsById } = modelIndexes(project);
  return {
    project: projectSummary(project, selectedTableId),
    tables: project.model.tables.map((table) => ({
      id: table.id,
      ref: tableRef(table),
      columns: table.columns.map((column) => column.name),
      primaryKey: table.columns.filter((column) => column.primaryKey).map((column) => column.name),
    })),
    relations: project.model.relations.map((relation) => relationRef(relation, tablesById, columnsById)),
  };
}

function buildManifestContext(project: VisualProject, selectedTableId?: string) {
  const { tablesById, columnsById } = modelIndexes(project);
  return {
    kind: "manifest",
    project: projectSummary(project, selectedTableId),
    tables: project.model.tables.map((table) => ({
      id: table.id,
      ref: tableRef(table),
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        pk: column.primaryKey || undefined,
        unique: column.unique || undefined,
      })),
      indexes: table.indexes.length,
    })),
    relations: project.model.relations.map((relation) => relationRef(relation, tablesById, columnsById)),
  };
}

function buildTableDetailsContext(project: VisualProject, tableNames: string[], selectedTableId?: string) {
  const { tablesById, columnsById } = modelIndexes(project);
  const selectedTable = selectedTableId ? project.model.tables.find((table) => table.id === selectedTableId) : undefined;
  const requestedTables = resolveTables(project, tableNames);
  const tables = requestedTables.length ? requestedTables : selectedTable ? [selectedTable] : [];
  const tableIds = new Set(tables.map((table) => table.id));

  return {
    kind: "table_details",
    project: projectSummary(project, selectedTableId),
    tables: tables.map((table) => ({
      id: table.id,
      ref: tableRef(table),
      columns: table.columns.map(compactColumn),
      indexes: table.indexes.map(compactIndex),
    })),
    relations: project.model.relations
      .filter((relation) => tableIds.has(relation.fromTableId) || tableIds.has(relation.toTableId))
      .map((relation) => relationRef(relation, tablesById, columnsById)),
  };
}

function buildAllTablesColumnsContext(project: VisualProject, selectedTableId?: string) {
  return {
    kind: "all_tables_columns",
    project: projectSummary(project, selectedTableId),
    tables: project.model.tables.map((table) => ({
      id: table.id,
      ref: tableRef(table),
      columns: table.columns.map(compactColumn),
    })),
  };
}

function buildFullCompactModelContext(project: VisualProject, selectedTableId?: string) {
  const { tablesById, columnsById } = modelIndexes(project);
  return {
    kind: "full_compact_model",
    project: projectSummary(project, selectedTableId),
    schemas: project.model.schemas,
    tables: project.model.tables.map((table) => ({
      id: table.id,
      ref: tableRef(table),
      columns: table.columns.map(compactColumn),
      indexes: table.indexes.map(compactIndex),
    })),
    relations: project.model.relations.map((relation) => relationRef(relation, tablesById, columnsById)),
  };
}

export function buildAiModelContext(project: VisualProject, plan: AiContextPlan, selectedTableId?: string) {
  if (plan.contextLevel === "table_details") return buildTableDetailsContext(project, plan.tablesNeeded, selectedTableId);
  if (plan.contextLevel === "all_tables_columns") return buildAllTablesColumnsContext(project, selectedTableId);
  if (plan.contextLevel === "full_compact_model") return buildFullCompactModelContext(project, selectedTableId);
  return buildManifestContext(project, selectedTableId);
}
