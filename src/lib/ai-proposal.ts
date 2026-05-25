export const allowedAiChangeTypes = new Set([
  "add_table",
  "add_column",
  "update_column",
  "remove_column",
  "remove_table",
  "add_relation",
  "remove_relation",
]);

const changeTypeAliases: Record<string, string> = {
  "add-table": "add_table",
  "create-table": "add_table",
  "new-table": "add_table",
  "create-entity": "add_table",
  "add-entity": "add_table",
  "add-column": "add_column",
  "create-column": "add_column",
  "new-column": "add_column",
  "update-column": "update_column",
  "edit-column": "update_column",
  "modify-column": "update_column",
  "remove-column": "remove_column",
  "delete-column": "remove_column",
  "drop-column": "remove_column",
  "remove-table": "remove_table",
  "delete-table": "remove_table",
  "drop-table": "remove_table",
  "add-relation": "add_relation",
  "create-relation": "add_relation",
  "add-relationship": "add_relation",
  "create-relationship": "add_relation",
  "add-foreign-key": "add_relation",
  "create-foreign-key": "add_relation",
  "add-fk": "add_relation",
  "create-fk": "add_relation",
  "foreign-key": "add_relation",
  "remove-relation": "remove_relation",
  "delete-relation": "remove_relation",
  "drop-relation": "remove_relation",
  "remove-relationship": "remove_relation",
  "remove-foreign-key": "remove_relation",
  "drop-foreign-key": "remove_relation",
  "remove-fk": "remove_relation",
};

function normalizedToken(value: unknown) {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, "-")
    : undefined;
}

function normalizeChangeType(value: unknown) {
  const token = normalizedToken(value);
  if (!token) return value;
  return changeTypeAliases[token] ?? token.replaceAll("-", "_");
}

function normalizeCardinality(value: unknown) {
  const token = normalizedToken(value);
  if (!token) return value;
  if (["one-to-one", "one-1", "1-1", "1:1", "1-to-1"].includes(token)) return "one-to-one";
  if (["one-to-many", "one-n", "1-n", "1:n", "1-to-n", "1-many"].includes(token)) return "one-to-many";
  return value;
}

function normalizeReferentialAction(value: unknown) {
  const token = normalizedToken(value);
  if (!token) return value;
  if (["no-action", "none"].includes(token)) return "no action";
  if (token === "restrict") return "restrict";
  if (token === "cascade") return "cascade";
  if (["set-null", "null"].includes(token)) return "set null";
  if (["set-default", "default"].includes(token)) return "set default";
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(value: unknown) {
  return typeof value === "string" && Boolean(value.trim());
}

function nonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function firstDefined(record: Record<string, unknown>, keys: string[]) {
  return keys.map((key) => record[key]).find((value) => value !== undefined && value !== null && value !== "");
}

function withAlias(record: Record<string, unknown>, targetKey: string, aliases: string[]) {
  if (record[targetKey] !== undefined) return record;
  const value = firstDefined(record, aliases);
  return value === undefined ? record : { ...record, [targetKey]: value };
}

function splitQualifiedTable(value: unknown) {
  if (typeof value !== "string") return undefined;
  const parts = value
    .replaceAll('"', "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return undefined;
  return { schema: parts.slice(0, -1).join("."), name: parts.at(-1) };
}

function splitQualifiedColumn(value: unknown) {
  if (typeof value !== "string") return undefined;
  const parts = value
    .replaceAll('"', "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return undefined;
  return {
    tableName: parts.length > 2 ? parts.slice(0, -1).join(".") : parts[0],
    columnName: parts.at(-1),
  };
}

function normalizeColumnInput(value: unknown) {
  if (!isRecord(value)) return value;
  let column = { ...value };
  column = withAlias(column, "name", ["columnName", "fieldName", "field", "column_name"]);
  column = withAlias(column, "type", ["dataType", "dbType", "sqlType", "columnType", "data_type"]);
  column = withAlias(column, "primaryKey", ["primary_key", "primary", "pk", "isPrimaryKey"]);
  column = withAlias(column, "defaultValue", ["default", "default_value", "defaultSql", "defaultExpression"]);
  column = withAlias(column, "nullable", ["isNullable", "optional"]);
  column = withAlias(column, "unique", ["isUnique"]);
  return column;
}

function normalizeColumns(value: unknown) {
  return Array.isArray(value) ? value.map(normalizeColumnInput) : value;
}

function patchFromTopLevel(change: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  ["name", "nullable", "primaryKey", "unique", "defaultValue"].forEach((key) => {
    if (change[key] !== undefined) patch[key] = change[key];
  });
  const typeValue = change.columnType ?? change.dataType ?? change.data_type ?? change.sqlType;
  if (typeValue !== undefined) patch.type = typeValue;
  return Object.keys(patch).length ? normalizeColumnInput(patch) : undefined;
}

function normalizeChange(change: Record<string, unknown>) {
  let normalized: Record<string, unknown> = { ...change, type: normalizeChangeType(change.type) };

  if (normalized.type === "add_table") {
    normalized = withAlias(normalized, "name", ["tableName", "table", "table_name", "entityName"]);
    normalized = withAlias(normalized, "columns", ["fields"]);
    const qualifiedName = splitQualifiedTable(normalized.name);
    if (qualifiedName) {
      normalized = {
        ...normalized,
        schema: normalized.schema ?? qualifiedName.schema,
        name: qualifiedName.name,
      };
    }
    if (normalized.columns !== undefined) {
      normalized = { ...normalized, columns: normalizeColumns(normalized.columns) };
    }
    return normalized;
  }

  if (normalized.type === "add_column") {
    normalized = withAlias(normalized, "tableName", ["table", "table_name", "targetTable", "targetTableName"]);
    if (!isRecord(normalized.column)) {
      const column = normalizeColumnInput({
        name: normalized.columnName ?? normalized.name,
        type: normalized.columnType ?? normalized.dataType ?? normalized.data_type ?? normalized.sqlType,
        nullable: normalized.nullable,
        primaryKey: normalized.primaryKey ?? normalized.primary_key ?? normalized.pk,
        unique: normalized.unique,
        defaultValue: normalized.defaultValue ?? normalized.default,
      });
      if (isRecord(column) && stringField(column.name)) normalized = { ...normalized, column };
    } else {
      normalized = { ...normalized, column: normalizeColumnInput(normalized.column) };
    }
    return normalized;
  }

  if (normalized.type === "update_column") {
    normalized = withAlias(normalized, "tableName", ["table", "table_name"]);
    normalized = withAlias(normalized, "columnName", ["column", "column_name", "fieldName"]);
    const patch = nonEmptyRecord(change.patch)
      ? change.patch
      : nonEmptyRecord(change.columnPatch)
        ? change.columnPatch
        : nonEmptyRecord(change.updates)
          ? change.updates
          : nonEmptyRecord(change.set)
            ? change.set
            : patchFromTopLevel(normalized);

    return patch ? { ...normalized, patch: normalizeColumnInput(patch) } : normalized;
  }

  if (normalized.type === "remove_column") {
    normalized = withAlias(normalized, "tableName", ["table", "table_name"]);
    normalized = withAlias(normalized, "columnName", ["column", "column_name", "fieldName"]);
    return normalized;
  }

  if (normalized.type === "remove_table") {
    return withAlias(normalized, "tableName", ["table", "table_name", "name"]);
  }

  if (normalized.type === "remove_relation") {
    return withAlias(normalized, "relationName", ["name", "constraintName", "foreignKeyName"]);
  }

  if (normalized.type === "add_relation") {
    normalized = withAlias(normalized, "fromTableName", [
      "fromTable",
      "sourceTable",
      "sourceTableName",
      "from_table",
      "source_table",
    ]);
    normalized = withAlias(normalized, "toTableName", [
      "toTable",
      "targetTable",
      "targetTableName",
      "referencedTable",
      "referencesTable",
      "to_table",
      "target_table",
    ]);
    normalized = withAlias(normalized, "fromColumnName", [
      "fromColumn",
      "sourceColumn",
      "sourceColumnName",
      "from_column",
      "source_column",
    ]);
    normalized = withAlias(normalized, "toColumnName", [
      "toColumn",
      "targetColumn",
      "targetColumnName",
      "referencedColumn",
      "referencesColumn",
      "to_column",
      "target_column",
    ]);

    const sourceRef = splitQualifiedColumn(normalized.source ?? normalized.from);
    const targetRef = splitQualifiedColumn(normalized.target ?? normalized.to);
    const references = isRecord(normalized.references) ? normalized.references : undefined;

    normalized = {
      ...normalized,
      fromTableName: normalized.fromTableName ?? sourceRef?.tableName,
      fromColumnName: normalized.fromColumnName ?? sourceRef?.columnName,
      toTableName: normalized.toTableName ?? targetRef?.tableName ?? references?.table ?? references?.tableName,
      toColumnName:
        normalized.toColumnName ?? targetRef?.columnName ?? references?.column ?? references?.columnName ?? "id",
      cardinality: normalizeCardinality(normalized.cardinality),
      onDelete: normalizeReferentialAction(normalized.onDelete),
      onUpdate: normalizeReferentialAction(normalized.onUpdate),
    };
    return normalized;
  }

  return normalized;
}

function isRunnableChange(change: Record<string, unknown>) {
  if (change.type === "add_table") return stringField(change.name);
  if (change.type === "add_column") return isRecord(change.column) && stringField(change.column.name);
  if (change.type === "update_column") {
    return (
      nonEmptyRecord(change.patch) &&
      (stringField(change.tableId) || stringField(change.tableName)) &&
      (stringField(change.columnId) || stringField(change.columnName))
    );
  }
  if (change.type === "remove_column") {
    return (
      (stringField(change.tableId) || stringField(change.tableName)) &&
      (stringField(change.columnId) || stringField(change.columnName))
    );
  }
  if (change.type === "remove_table") return stringField(change.tableId) || stringField(change.tableName);
  if (change.type === "add_relation") {
    return (
      (stringField(change.fromTableId) || stringField(change.fromTableName)) &&
      (stringField(change.fromColumnId) || stringField(change.fromColumnName)) &&
      (stringField(change.toTableId) || stringField(change.toTableName)) &&
      (stringField(change.toColumnId) || stringField(change.toColumnName))
    );
  }
  if (change.type === "remove_relation") return stringField(change.relationId) || stringField(change.relationName);
  return false;
}

function describeInvalidChange(change: Record<string, unknown>) {
  return `Ignored incomplete AI change of type ${String(change.type)}.`;
}

export function normalizeAiProposalPayload(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("The AI response was not a JSON object.");
  }

  const input = value as {
    message?: unknown;
    changes?: unknown;
    tables?: unknown;
    entities?: unknown;
    relations?: unknown;
    relationships?: unknown;
    foreignKeys?: unknown;
    foreign_keys?: unknown;
    warnings?: unknown;
  };
  const warnings = Array.isArray(input.warnings)
    ? input.warnings.filter((warning): warning is string => typeof warning === "string" && Boolean(warning.trim()))
    : [];
  const changes = [
    ...(Array.isArray(input.changes) ? input.changes : []),
    ...(Array.isArray(input.tables) ? input.tables.map((table) => ({ type: "add_table", ...(isRecord(table) ? table : {}) })) : []),
    ...(Array.isArray(input.entities)
      ? input.entities.map((table) => ({ type: "add_table", ...(isRecord(table) ? table : {}) }))
      : []),
    ...(Array.isArray(input.relations)
      ? input.relations.map((relation) => ({ type: "add_relation", ...(isRecord(relation) ? relation : {}) }))
      : []),
    ...(Array.isArray(input.relationships)
      ? input.relationships.map((relation) => ({ type: "add_relation", ...(isRecord(relation) ? relation : {}) }))
      : []),
    ...(Array.isArray(input.foreignKeys)
      ? input.foreignKeys.map((relation) => ({ type: "add_relation", ...(isRecord(relation) ? relation : {}) }))
      : []),
    ...(Array.isArray(input.foreign_keys)
      ? input.foreign_keys.map((relation) => ({ type: "add_relation", ...(isRecord(relation) ? relation : {}) }))
      : []),
  ];
  const validChanges: unknown[] = [];
  const invalidChangeWarnings: string[] = [];

  changes.forEach((change) => {
    if (!change || typeof change !== "object") return;
    const normalizedChange = normalizeChange(change as Record<string, unknown>);
    const type = normalizedChange.type;
    if (allowedAiChangeTypes.has(String(type))) {
      if (isRunnableChange(normalizedChange)) {
        validChanges.push(normalizedChange);
        return;
      }
      invalidChangeWarnings.push(describeInvalidChange(change as Record<string, unknown>));
      return;
    }
    if (type === "message") {
      const message =
        (change as { message?: unknown; text?: unknown; content?: unknown }).message ??
        (change as { message?: unknown; text?: unknown; content?: unknown }).text ??
        (change as { message?: unknown; text?: unknown; content?: unknown }).content;
      if (typeof message === "string" && message.trim()) warnings.push(message.trim());
    }
  });

  if (invalidChangeWarnings.length > 0) {
    return {
      message: "The AI returned an incomplete proposal. No model changes were prepared.",
      changes: [],
      warnings: [...warnings, ...invalidChangeWarnings],
    };
  }

  return {
    message:
      typeof input.message === "string" && input.message.trim()
        ? input.message.trim()
        : validChanges.length
          ? "I prepared a proposal."
          : "I could not find any applicable model changes in the AI response.",
    changes: validChanges,
    warnings,
  };
}
