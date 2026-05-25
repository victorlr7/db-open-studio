import { nowIso } from "./defaults";
import type {
  DbColumn,
  DbRelation,
  DbTable,
  DiffItem,
  DiffSummary,
  GeneratedMigration,
  SchemaModel,
  VisualProject,
} from "./types";

function tableKey(table: DbTable) {
  return `${table.schema}.${table.name}`;
}

function relationKey(relation: DbRelation, model: SchemaModel) {
  const fromTable = model.tables.find((table) => table.id === relation.fromTableId);
  const toTable = model.tables.find((table) => table.id === relation.toTableId);
  const fromColumn = fromTable?.columns.find((column) => column.id === relation.fromColumnId);
  const toColumn = toTable?.columns.find((column) => column.id === relation.toColumnId);
  return [
    fromTable ? tableKey(fromTable) : relation.fromTableId,
    fromColumn?.name ?? relation.fromColumnId,
    toTable ? tableKey(toTable) : relation.toTableId,
    toColumn?.name ?? relation.toColumnId,
  ].join("->");
}

function equivalentColumn(before: DbColumn, after: DbColumn) {
  const changes: string[] = [];
  if (before.type !== after.type) changes.push("type");
  if (before.nullable !== after.nullable) changes.push("nullable");
  if ((before.defaultValue ?? "") !== (after.defaultValue ?? "")) changes.push("default");
  if (before.primaryKey !== after.primaryKey) changes.push("primaryKey");
  if (before.unique !== after.unique) changes.push("unique");
  return changes;
}

export function diffSchemas(before: SchemaModel, after: SchemaModel): DiffSummary {
  const items: DiffItem[] = [];
  const beforeTables = new Map(before.tables.map((table) => [tableKey(table), table]));
  const afterTables = new Map(after.tables.map((table) => [tableKey(table), table]));

  afterTables.forEach((table, key) => {
    if (!beforeTables.has(key)) {
      items.push({ type: "added_table", table });
    }
  });

  beforeTables.forEach((table, key) => {
    if (!afterTables.has(key)) {
      items.push({ type: "removed_table", table });
    }
  });

  afterTables.forEach((afterTable, key) => {
    const beforeTable = beforeTables.get(key);
    if (!beforeTable) return;

    const beforeColumns = new Map(beforeTable.columns.map((column) => [column.name, column]));
    const afterColumns = new Map(afterTable.columns.map((column) => [column.name, column]));

    afterColumns.forEach((column, columnName) => {
      const beforeColumn = beforeColumns.get(columnName);
      if (!beforeColumn) {
        items.push({ type: "added_column", table: afterTable, column });
        return;
      }

      const changes = equivalentColumn(beforeColumn, column);
      if (changes.length) {
        items.push({
          type: "modified_column",
          table: afterTable,
          before: beforeColumn,
          after: column,
          changes,
        });
      }
    });

    beforeColumns.forEach((column, columnName) => {
      if (!afterColumns.has(columnName)) {
        items.push({ type: "removed_column", table: beforeTable, column });
      }
    });
  });

  const beforeRelations = new Map(before.relations.map((relation) => [relationKey(relation, before), relation]));
  const afterRelations = new Map(after.relations.map((relation) => [relationKey(relation, after), relation]));

  afterRelations.forEach((relation, key) => {
    if (!beforeRelations.has(key)) items.push({ type: "added_relation", relation });
  });

  beforeRelations.forEach((relation, key) => {
    if (!afterRelations.has(key)) items.push({ type: "removed_relation", relation });
  });

  const counts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.type] = (acc[item.type] ?? 0) + 1;
    return acc;
  }, {});

  return { items, counts };
}

function q(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableRef(table: DbTable) {
  return `${q(table.schema)}.${q(table.name)}`;
}

function columnSql(column: DbColumn, inlinePrimary = false) {
  const parts = [q(column.name), column.type];
  if (column.defaultValue) parts.push("DEFAULT", column.defaultValue);
  if (!column.nullable) parts.push("NOT NULL");
  if (inlinePrimary && column.primaryKey) parts.push("PRIMARY KEY");
  if (column.unique) parts.push("UNIQUE");
  return parts.join(" ");
}

function relationSql(relation: DbRelation, model: SchemaModel) {
  const fromTable = model.tables.find((table) => table.id === relation.fromTableId);
  const toTable = model.tables.find((table) => table.id === relation.toTableId);
  const fromColumn = fromTable?.columns.find((column) => column.id === relation.fromColumnId);
  const toColumn = toTable?.columns.find((column) => column.id === relation.toColumnId);

  if (!fromTable || !toTable || !fromColumn || !toColumn) return undefined;

  const parts = [
    `ALTER TABLE ${tableRef(fromTable)} ADD CONSTRAINT ${q(relation.name || `${fromTable.name}_${fromColumn.name}_fkey`)}`,
    `FOREIGN KEY (${q(fromColumn.name)}) REFERENCES ${tableRef(toTable)} (${q(toColumn.name)})`,
  ];

  if (relation.onDelete && relation.onDelete !== "no action") {
    parts.push(`ON DELETE ${relation.onDelete.toUpperCase()}`);
  }
  if (relation.onUpdate && relation.onUpdate !== "no action") {
    parts.push(`ON UPDATE ${relation.onUpdate.toUpperCase()}`);
  }

  return `${parts.join(" ")};`;
}

export function generateMigration(project: VisualProject): GeneratedMigration {
  const before = project.snapshot?.schema ?? { version: 1, schemas: ["public"], tables: [], relations: [] };
  const after = project.model;
  const summary = diffSchemas(before, after);
  const warnings: string[] = [];
  const sql: string[] = [
    `-- DBOpenStudio migration for ${project.name}`,
    `-- Generated at ${nowIso()}`,
    "",
  ];

  after.schemas.forEach((schema) => {
    if (schema !== "public") {
      sql.push(`CREATE SCHEMA IF NOT EXISTS ${q(schema)};`);
    }
  });

  summary.items.forEach((item) => {
    if (item.type === "added_table") {
      const primaryColumns = item.table.columns.filter((column) => column.primaryKey);
      const columnLines = item.table.columns.map((column) => `  ${columnSql(column)}`);
      const constraintLines =
        primaryColumns.length > 0
          ? [
              `  CONSTRAINT ${q(`${item.table.name}_pkey`)} PRIMARY KEY (${primaryColumns
                .map((column) => q(column.name))
                .join(", ")})`,
            ]
          : [];
      sql.push(
        `CREATE TABLE ${tableRef(item.table)} (\n${[...columnLines, ...constraintLines].join(",\n")}\n);`,
        "",
      );
    }

    if (item.type === "removed_table") {
      warnings.push(`Table ${item.table.schema}.${item.table.name} is removed in the drawing. Destructive operation.`);
      sql.push(`-- DROP TABLE ${tableRef(item.table)}; -- Destructivo: revisar manualmente`, "");
    }

    if (item.type === "added_column") {
      sql.push(`ALTER TABLE ${tableRef(item.table)} ADD COLUMN ${columnSql(item.column)};`, "");
    }

    if (item.type === "removed_column") {
      warnings.push(
        `La columna ${item.table.schema}.${item.table.name}.${item.column.name} se elimina en el dibujo. Operacion destructiva.`,
      );
      sql.push(
        `-- ALTER TABLE ${tableRef(item.table)} DROP COLUMN ${q(item.column.name)}; -- Destructivo: revisar manualmente`,
        "",
      );
    }

    if (item.type === "modified_column") {
      const ref = `${tableRef(item.table)} ${q(item.after.name)}`;
      if (item.changes.includes("type")) {
        warnings.push(
          `La columna ${item.table.schema}.${item.table.name}.${item.after.name} cambia de ${item.before.type} a ${item.after.type}. Puede requerir cast manual.`,
        );
        sql.push(
          `ALTER TABLE ${tableRef(item.table)} ALTER COLUMN ${q(item.after.name)} TYPE ${item.after.type} USING ${q(item.after.name)}::${item.after.type};`,
        );
      }
      if (item.changes.includes("nullable")) {
        if (item.after.nullable) {
          sql.push(`ALTER TABLE ${ref} DROP NOT NULL;`);
        } else {
          warnings.push(
            `Aplicar NOT NULL en ${item.table.schema}.${item.table.name}.${item.after.name} puede fallar si existen nulos.`,
          );
          sql.push(`ALTER TABLE ${ref} SET NOT NULL;`);
        }
      }
      if (item.changes.includes("default")) {
        if (item.after.defaultValue) {
          sql.push(`ALTER TABLE ${ref} SET DEFAULT ${item.after.defaultValue};`);
        } else {
          sql.push(`ALTER TABLE ${ref} DROP DEFAULT;`);
        }
      }
      if (item.changes.includes("primaryKey")) {
        warnings.push(
          `Cambio de primary key en ${item.table.schema}.${item.table.name}.${item.after.name}. Revisa constraints existentes antes de ejecutar.`,
        );
      }
      if (item.changes.includes("unique")) {
        if (item.after.unique) {
          sql.push(
            `ALTER TABLE ${tableRef(item.table)} ADD CONSTRAINT ${q(`${item.table.name}_${item.after.name}_key`)} UNIQUE (${q(item.after.name)});`,
          );
        } else {
          warnings.push(
            `Se ha quitado unique en ${item.table.schema}.${item.table.name}.${item.after.name}. El drop de constraint requiere confirmar el nombre real.`,
          );
        }
      }
      sql.push("");
    }

    if (item.type === "added_relation") {
      const statement = relationSql(item.relation, after);
      if (statement) sql.push(statement, "");
    }

    if (item.type === "removed_relation") {
      warnings.push("A relationship was removed. Dropping the constraint requires confirming the real name.");
      sql.push(`-- ALTER TABLE ... DROP CONSTRAINT ${q(item.relation.name)}; -- Revisar manualmente`, "");
    }
  });

  if (summary.items.length === 0) {
    sql.push("-- No hay cambios entre el snapshot y el modelo visual.");
  }

  return {
    id: crypto.randomUUID(),
    userId: project.userId,
    projectId: project.id,
    name: `Migration ${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
    sql: sql.join("\n"),
    warnings,
    summary,
    createdAt: nowIso(),
  };
}
