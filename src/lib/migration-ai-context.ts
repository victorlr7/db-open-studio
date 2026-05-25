import { normalizeProjectAiContext } from "./ai-context";
import type {
  DbColumn,
  DbRelation,
  DbTable,
  GeneratedMigration,
  SchemaModel,
  VisualProject,
} from "./types";

const MAX_SQL_CHARS = 32_000;
const MAX_TABLE_COLUMNS = 12;

function tableRef(table: DbTable) {
  return `${table.schema}.${table.name}`;
}

function compactColumn(column: DbColumn) {
  return {
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    primaryKey: column.primaryKey || undefined,
    unique: column.unique || undefined,
    defaultValue: column.defaultValue,
  };
}

function compactTable(table: DbTable, includeColumns = true) {
  const base = {
    ref: tableRef(table),
    columnCount: table.columns.length,
  };
  if (!includeColumns) return base;
  return {
    ...base,
    columns: table.columns.slice(0, MAX_TABLE_COLUMNS).map(compactColumn),
    truncatedColumns: table.columns.length > MAX_TABLE_COLUMNS || undefined,
  };
}

function modelIndexes(project: VisualProject) {
  const models: SchemaModel[] = [project.snapshot?.schema, project.model].filter(Boolean) as SchemaModel[];
  const tablesById = new Map<string, DbTable>();
  const columnsById = new Map<string, DbColumn>();

  models.forEach((model) => {
    model.tables.forEach((table) => {
      tablesById.set(table.id, table);
      table.columns.forEach((column) => columnsById.set(column.id, column));
    });
  });

  return { tablesById, columnsById };
}

function relationRef(relation: DbRelation, tablesById: Map<string, DbTable>, columnsById: Map<string, DbColumn>) {
  const fromTable = tablesById.get(relation.fromTableId);
  const toTable = tablesById.get(relation.toTableId);
  const fromColumn = columnsById.get(relation.fromColumnId);
  const toColumn = columnsById.get(relation.toColumnId);

  return {
    name: relation.name,
    from: fromTable && fromColumn ? `${tableRef(fromTable)}.${fromColumn.name}` : relation.fromColumnId,
    to: toTable && toColumn ? `${tableRef(toTable)}.${toColumn.name}` : relation.toColumnId,
    cardinality: relation.cardinality,
    identifying: relation.identifying || undefined,
    onDelete: relation.onDelete,
    onUpdate: relation.onUpdate,
  };
}

function truncateSql(sql: string) {
  if (sql.length <= MAX_SQL_CHARS) {
    return {
      sql,
      sqlTruncated: false,
      originalSqlLength: sql.length,
    };
  }

  const headLength = Math.floor(MAX_SQL_CHARS * 0.7);
  const tailLength = MAX_SQL_CHARS - headLength;
  return {
    sql: [
      sql.slice(0, headLength),
      "\n\n-- DBOpenStudio note: SQL truncated for AI review context. Middle omitted.\n\n",
      sql.slice(-tailLength),
    ].join(""),
    sqlTruncated: true,
    originalSqlLength: sql.length,
  };
}

export function buildMigrationReviewInput(project: VisualProject, migration: GeneratedMigration) {
  const { tablesById, columnsById } = modelIndexes(project);
  const affectedTables = new Map<string, DbTable>();
  const { sql, sqlTruncated, originalSqlLength } = truncateSql(migration.sql);

  const changes = migration.summary.items.map((item) => {
    if (item.type === "added_table" || item.type === "removed_table") {
      affectedTables.set(item.table.id, item.table);
      return {
        type: item.type,
        table: compactTable(item.table),
      };
    }

    if (item.type === "added_column" || item.type === "removed_column") {
      affectedTables.set(item.table.id, item.table);
      return {
        type: item.type,
        table: tableRef(item.table),
        column: compactColumn(item.column),
      };
    }

    if (item.type === "modified_column") {
      affectedTables.set(item.table.id, item.table);
      return {
        type: item.type,
        table: tableRef(item.table),
        column: item.after.name,
        changes: item.changes,
        before: compactColumn(item.before),
        after: compactColumn(item.after),
      };
    }

    const fromTable = tablesById.get(item.relation.fromTableId);
    const toTable = tablesById.get(item.relation.toTableId);
    if (fromTable) affectedTables.set(fromTable.id, fromTable);
    if (toTable) affectedTables.set(toTable.id, toTable);

    return {
      type: item.type,
      relation: relationRef(item.relation, tablesById, columnsById),
    };
  });

  return {
    project: {
      name: project.name,
      description: project.description,
      aiContext: normalizeProjectAiContext(project.aiContext),
      modelCounts: {
        schemas: project.model.schemas.length,
        tables: project.model.tables.length,
        relations: project.model.relations.length,
      },
    },
    migration: {
      name: migration.name,
      createdAt: migration.createdAt,
      warnings: migration.warnings,
      counts: migration.summary.counts,
      changeCount: migration.summary.items.length,
      sql,
      sqlTruncated,
      originalSqlLength,
    },
    changes,
    affectedTables: Array.from(affectedTables.values()).map((table) => compactTable(table, false)),
  };
}
