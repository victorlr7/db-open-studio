import {
  createColumn,
  createTable,
  DEFAULT_TABLE_NODE_HEIGHT,
  DEFAULT_TABLE_NODE_WIDTH,
} from "./defaults";
import type { DbColumn, DbRelation, DbTable, VisualProject } from "./types";

export type AiColumnInput = {
  name: string;
  type?: string;
  nullable?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  defaultValue?: string | null;
};

export type AiModelChange =
  | {
      type: "add_table";
      schema?: string;
      name: string;
      columns?: AiColumnInput[];
      visible?: boolean;
    }
  | {
      type: "add_column";
      tableId?: string;
      tableName?: string;
      column: AiColumnInput;
    }
  | {
      type: "update_column";
      tableId?: string;
      tableName?: string;
      columnId?: string;
      columnName?: string;
      patch: Partial<AiColumnInput>;
    }
  | {
      type: "remove_column";
      tableId?: string;
      tableName?: string;
      columnId?: string;
      columnName?: string;
    }
  | {
      type: "remove_table";
      tableId?: string;
      tableName?: string;
    }
  | {
      type: "add_relation";
      name?: string;
      fromTableId?: string;
      fromTableName?: string;
      fromColumnId?: string;
      fromColumnName?: string;
      toTableId?: string;
      toTableName?: string;
      toColumnId?: string;
      toColumnName?: string;
      cardinality?: "one-to-many" | "one-to-one";
      identifying?: boolean;
      onDelete?: DbRelation["onDelete"];
      onUpdate?: DbRelation["onUpdate"];
    }
  | {
      type: "remove_relation";
      relationId?: string;
      relationName?: string;
    };

export type AiProposal = {
  message: string;
  changes: AiModelChange[];
  warnings?: string[];
};

export type AppliedAiChanges = {
  project: VisualProject;
  applied: string[];
  skipped: string[];
  committed: boolean;
};

type ApplyAiChangesOptions = {
  atomic?: boolean;
};

function safeName(name: string, fallback: string) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || fallback
  );
}

function uniqueName(existing: string[], requested: string) {
  if (!existing.includes(requested)) return requested;
  let index = 2;
  let next = `${requested}_${index}`;
  while (existing.includes(next)) {
    index += 1;
    next = `${requested}_${index}`;
  }
  return next;
}

function tableRef(table: DbTable) {
  return `${table.schema}.${table.name}`;
}

function normalizeLookupName(value: string) {
  return safeName(value.replace(/^"+|"+$/g, ""), value.trim().toLowerCase());
}

function findTable(project: VisualProject, tableId?: string, tableName?: string) {
  const normalizedTableName = tableName ? normalizeLookupName(tableName) : undefined;
  return project.model.tables.find((table) => {
    if (tableId && table.id === tableId) return true;
    if (!tableName) return false;
    return (
      normalizeLookupName(table.name) === normalizedTableName ||
      normalizeLookupName(tableRef(table)) === normalizedTableName
    );
  });
}

function findColumn(table: DbTable | undefined, columnId?: string, columnName?: string) {
  const normalizedColumnName = columnName ? normalizeLookupName(columnName) : undefined;
  return table?.columns.find((column) => {
    if (columnId && column.id === columnId) return true;
    return Boolean(normalizedColumnName && normalizeLookupName(column.name) === normalizedColumnName);
  });
}

function desiredTableHeight(table: DbTable) {
  return Math.max(DEFAULT_TABLE_NODE_HEIGHT, 58 + table.columns.length * 32);
}

function applyColumnInput(column: DbColumn, input: Partial<AiColumnInput>) {
  const primaryKey = input.primaryKey ?? column.primaryKey;
  return {
    ...column,
    name: input.name ? safeName(input.name, column.name) : column.name,
    type: input.type || column.type,
    nullable: primaryKey ? false : (input.nullable ?? column.nullable),
    primaryKey,
    unique: input.unique ?? column.unique,
    defaultValue:
      input.defaultValue === null ? undefined : input.defaultValue !== undefined ? input.defaultValue : column.defaultValue,
  };
}

function createColumnFromInput(table: DbTable, input: AiColumnInput) {
  const name = uniqueName(
    table.columns.map((column) => column.name),
    safeName(input.name, "column"),
  );
  return applyColumnInput(
    createColumn(name, {
      type: input.type || "text",
      nullable: input.primaryKey ? false : (input.nullable ?? true),
      primaryKey: input.primaryKey ?? false,
      unique: input.unique ?? false,
      defaultValue: input.defaultValue === null ? undefined : (input.defaultValue ?? undefined),
    }),
    { ...input, name },
  );
}

function ensureTableVisible(project: VisualProject, table: DbTable, x?: number, y?: number) {
  if (project.canvas.nodes.some((node) => node.id === table.id)) return project.canvas;
  return {
    ...project.canvas,
    nodes: [
      ...project.canvas.nodes,
      {
        id: table.id,
        position: {
          x: x ?? 140 + (project.canvas.nodes.length % 4) * 300,
          y: y ?? 140 + Math.floor(project.canvas.nodes.length / 4) * 210,
        },
        width: DEFAULT_TABLE_NODE_WIDTH,
        height: desiredTableHeight(table),
      },
    ],
  };
}

function updateVisibleTableHeight(project: VisualProject, table: DbTable) {
  return {
    ...project.canvas,
    nodes: project.canvas.nodes.map((node) =>
      node.id === table.id && !node.collapsed ? { ...node, height: Math.max(node.height ?? 0, desiredTableHeight(table)) } : node,
    ),
  };
}

function relationExists(project: VisualProject, input: Pick<DbRelation, "fromTableId" | "fromColumnId" | "toTableId" | "toColumnId">) {
  return project.model.relations.some(
    (relation) =>
      relation.fromTableId === input.fromTableId &&
      relation.fromColumnId === input.fromColumnId &&
      relation.toTableId === input.toTableId &&
      relation.toColumnId === input.toColumnId,
  );
}

export function describeAiChange(change: AiModelChange, project: VisualProject) {
  if (change.type === "add_table") return `Add table ${change.schema ?? "public"}.${change.name}`;
  if (change.type === "add_column") return `Add column ${change.column.name} in ${change.tableName ?? change.tableId ?? "table"}`;
  if (change.type === "update_column") return `Update column ${change.columnName ?? change.columnId ?? "column"} in ${change.tableName ?? change.tableId ?? "table"}`;
  if (change.type === "remove_column") return `Remove column ${change.columnName ?? change.columnId ?? "column"} in ${change.tableName ?? change.tableId ?? "table"}`;
  if (change.type === "remove_table") return `Remove table ${change.tableName ?? change.tableId ?? "table"}`;
  if (change.type === "add_relation") {
    const fromTable = findTable(project, change.fromTableId, change.fromTableName);
    const toTable = findTable(project, change.toTableId, change.toTableName);
    return `Add FK ${fromTable?.name ?? change.fromTableName ?? "source"}.${change.fromColumnName ?? change.fromColumnId ?? "field"} -> ${toTable?.name ?? change.toTableName ?? "target"}.${change.toColumnName ?? change.toColumnId ?? "field"}`;
  }
  return `Remove FK ${change.relationName ?? change.relationId ?? ""}`.trim();
}

export function isDestructiveAiChange(change: AiModelChange) {
  return change.type === "remove_column" || change.type === "remove_table" || change.type === "remove_relation";
}

export function applyAiChanges(
  project: VisualProject,
  changes: AiModelChange[],
  options: ApplyAiChangesOptions = {},
): AppliedAiChanges {
  let nextProject = project;
  const applied: string[] = [];
  const skipped: string[] = [];
  const atomic = options.atomic ?? true;
  const order: Record<AiModelChange["type"], number> = {
    add_table: 0,
    add_column: 1,
    update_column: 2,
    add_relation: 3,
    remove_relation: 4,
    remove_column: 5,
    remove_table: 6,
  };
  const orderedChanges = changes
    .map((change, index) => ({ change, index }))
    .sort((left, right) => order[left.change.type] - order[right.change.type] || left.index - right.index)
    .map((item) => item.change);

  orderedChanges.forEach((change) => {
    if (change.type === "add_table") {
      const requestedTableName = safeName(change.name, "new_table");
      const existingTable = findTable(nextProject, undefined, `${change.schema ?? "public"}.${requestedTableName}`);
      if (existingTable) {
        applied.push(`${describeAiChange(change, project)}: already exists`);
        return;
      }
      const tableName = uniqueName(nextProject.model.tables.map((table) => table.name), requestedTableName);
      const { table: baseTable, node } = createTable(tableName);
      const columns = change.columns?.length
        ? change.columns.map((column) => createColumnFromInput({ ...baseTable, columns: [] }, column))
        : baseTable.columns;
      const table: DbTable = {
        ...baseTable,
        schema: safeName(change.schema ?? "public", "public"),
        name: tableName,
        columns,
      };
      nextProject = {
        ...nextProject,
        model: {
          ...nextProject.model,
          schemas: Array.from(new Set([...nextProject.model.schemas, table.schema])),
          tables: [...nextProject.model.tables, table],
        },
        canvas:
          change.visible === false
            ? nextProject.canvas
            : {
                ...nextProject.canvas,
                nodes: [...nextProject.canvas.nodes, { ...node, id: table.id, height: desiredTableHeight(table) }],
              },
      };
      applied.push(describeAiChange(change, project));
      return;
    }

    if (change.type === "add_column") {
      const table = findTable(nextProject, change.tableId, change.tableName);
      if (!table) {
        skipped.push(`${describeAiChange(change, project)}: table not found`);
        return;
      }
      const existingColumn = findColumn(table, undefined, safeName(change.column.name, "column"));
      if (existingColumn) {
        applied.push(`${describeAiChange(change, project)}: already exists`);
        return;
      }
      const column = createColumnFromInput(table, change.column);
      const nextTables = nextProject.model.tables.map((item) =>
        item.id === table.id ? { ...item, columns: [...item.columns, column] } : item,
      );
      const nextTable = nextTables.find((item) => item.id === table.id) ?? table;
      nextProject = {
        ...nextProject,
        model: { ...nextProject.model, tables: nextTables },
        canvas: updateVisibleTableHeight(nextProject, nextTable),
      };
      applied.push(describeAiChange(change, project));
      return;
    }

    if (change.type === "update_column") {
      const table = findTable(nextProject, change.tableId, change.tableName);
      const column = findColumn(table, change.columnId, change.columnName);
      if (!table || !column) {
        skipped.push(`${describeAiChange(change, project)}: columna no encontrada`);
        return;
      }
      nextProject = {
        ...nextProject,
        model: {
          ...nextProject.model,
          tables: nextProject.model.tables.map((item) =>
            item.id === table.id
              ? {
                  ...item,
                  columns: item.columns.map((itemColumn) =>
                    itemColumn.id === column.id ? applyColumnInput(itemColumn, change.patch) : itemColumn,
                  ),
                }
              : item,
          ),
        },
      };
      applied.push(describeAiChange(change, project));
      return;
    }

    if (change.type === "remove_column") {
      const table = findTable(nextProject, change.tableId, change.tableName);
      const column = findColumn(table, change.columnId, change.columnName);
      if (!table || !column) {
        skipped.push(`${describeAiChange(change, project)}: columna no encontrada`);
        return;
      }
      nextProject = {
        ...nextProject,
        model: {
          ...nextProject.model,
          tables: nextProject.model.tables.map((item) =>
            item.id === table.id ? { ...item, columns: item.columns.filter((itemColumn) => itemColumn.id !== column.id) } : item,
          ),
          relations: nextProject.model.relations.filter(
            (relation) => relation.fromColumnId !== column.id && relation.toColumnId !== column.id,
          ),
        },
      };
      applied.push(describeAiChange(change, project));
      return;
    }

    if (change.type === "remove_table") {
      const table = findTable(nextProject, change.tableId, change.tableName);
      if (!table) {
        skipped.push(`${describeAiChange(change, project)}: table not found`);
        return;
      }
      nextProject = {
        ...nextProject,
        model: {
          ...nextProject.model,
          tables: nextProject.model.tables.filter((item) => item.id !== table.id),
          relations: nextProject.model.relations.filter(
            (relation) => relation.fromTableId !== table.id && relation.toTableId !== table.id,
          ),
        },
        canvas: {
          ...nextProject.canvas,
          nodes: nextProject.canvas.nodes.filter((node) => node.id !== table.id),
        },
      };
      applied.push(describeAiChange(change, project));
      return;
    }

    if (change.type === "add_relation") {
      const fromTable = findTable(nextProject, change.fromTableId, change.fromTableName);
      const toTable = findTable(nextProject, change.toTableId, change.toTableName);
      const toColumn = findColumn(toTable, change.toColumnId, change.toColumnName);
      if (!fromTable || !toTable || !toColumn) {
        skipped.push(`${describeAiChange(change, project)}: target table or column not found`);
        return;
      }
      let fromColumn = findColumn(fromTable, change.fromColumnId, change.fromColumnName);
      let nextTables = nextProject.model.tables;
      const identifying = change.identifying ?? false;
      const cardinality = change.cardinality ?? "one-to-many";

      if (!fromColumn && change.fromColumnName) {
        fromColumn = createColumnFromInput(fromTable, {
          name: change.fromColumnName,
          type: toColumn.type,
          nullable: !identifying,
          primaryKey: identifying,
          unique: cardinality === "one-to-one",
        });
        nextTables = nextTables.map((table) =>
          table.id === fromTable.id ? { ...table, columns: [...table.columns, fromColumn as DbColumn] } : table,
        );
      }

      if (!fromColumn) {
        skipped.push(`${describeAiChange(change, project)}: columna origen no encontrada`);
        return;
      }

      fromColumn = {
        ...fromColumn,
        type: toColumn.type,
        nullable: identifying || fromColumn.primaryKey ? false : fromColumn.nullable,
        primaryKey: identifying ? true : fromColumn.primaryKey,
        unique: cardinality === "one-to-one" ? true : fromColumn.unique,
      };
      nextTables = nextTables.map((table) =>
        table.id === fromTable.id
          ? { ...table, columns: table.columns.map((column) => (column.id === fromColumn?.id ? (fromColumn as DbColumn) : column)) }
          : table,
      );

      const relationInput = {
        fromTableId: fromTable.id,
        fromColumnId: fromColumn.id,
        toTableId: toTable.id,
        toColumnId: toColumn.id,
      };
      if (relationExists(nextProject, relationInput)) {
        applied.push(`${describeAiChange(change, project)}: already exists`);
        return;
      }

      const relation: DbRelation = {
        id: crypto.randomUUID(),
        name: change.name || `${fromTable.name}_${fromColumn.name}_fkey`,
        cardinality,
        identifying,
        ...relationInput,
        onDelete: change.onDelete ?? "no action",
        onUpdate: change.onUpdate ?? "no action",
      };
      const nextFromTable = nextTables.find((table) => table.id === fromTable.id) ?? fromTable;
      nextProject = {
        ...nextProject,
        model: {
          ...nextProject.model,
          tables: nextTables,
          relations: [...nextProject.model.relations, relation],
        },
        canvas: ensureTableVisible({ ...nextProject, model: { ...nextProject.model, tables: nextTables } }, nextFromTable),
      };
      applied.push(describeAiChange(change, project));
      return;
    }

    if (change.type === "remove_relation") {
      const beforeCount = nextProject.model.relations.length;
      nextProject = {
        ...nextProject,
        model: {
          ...nextProject.model,
          relations: nextProject.model.relations.filter(
            (relation) => relation.id !== change.relationId && relation.name !== change.relationName,
          ),
        },
      };
      if (nextProject.model.relations.length === beforeCount) {
        skipped.push(`${describeAiChange(change, project)}: FK no encontrada`);
        return;
      }
      applied.push(describeAiChange(change, project));
    }
  });

  if (atomic && skipped.length > 0) {
    return { project, applied: [], skipped, committed: false };
  }

  return { project: nextProject, applied, skipped, committed: true };
}
