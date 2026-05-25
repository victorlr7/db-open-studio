import { Pool } from "pg";
import { id } from "./defaults";
import type { CanvasModel, DbColumn, DbRelation, DbTable, ProjectConnection, SchemaModel } from "./types";

type ImportInput = {
  connectionString?: string;
  supabaseUrl?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  schema?: string;
  ssl?: boolean;
};

function isDbOpenStudioInternalTable(tableName: string) {
  return tableName.startsWith("dbos_");
}

function isSslUnsupportedError(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().includes("does not support ssl connections");
}

function connectionStringWithNoVerifySsl(connectionString: string) {
  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) return connectionString;
    url.searchParams.set("sslmode", "no-verify");
    return url.toString();
  } catch {
    return connectionString;
  }
}

function mapAction(action?: string): DbRelation["onDelete"] {
  switch (action) {
    case "a":
      return "no action";
    case "r":
      return "restrict";
    case "c":
      return "cascade";
    case "n":
      return "set null";
    case "d":
      return "set default";
    default:
      return "no action";
  }
}

function columnType(row: Record<string, unknown>) {
  const udt = String(row.udt_name ?? row.data_type);
  if (udt === "varchar") {
    const max = row.character_maximum_length;
    return max ? `varchar(${max})` : "varchar";
  }
  if (udt === "numeric") {
    const precision = row.numeric_precision;
    const scale = row.numeric_scale;
    return precision ? `numeric(${precision}${scale ? `, ${scale}` : ""})` : "numeric";
  }
  if (udt === "int4") return "integer";
  if (udt === "int8") return "bigint";
  if (udt === "bool") return "boolean";
  if (udt === "timestamp") return "timestamp";
  if (udt === "timestamptz") return "timestamptz";
  return udt;
}

function parsedIndexColumnsFromDefinition(definition: string) {
  const match = definition.match(/\bUSING\s+\w+\s*\((.*)\)(?:\s+WHERE\b|$)/i) ?? definition.match(/\((.*)\)(?:\s+WHERE\b|$)/i);
  return (
    match?.[1]
      ?.split(",")
      .map((value) => value.replaceAll('"', "").trim())
      .filter(Boolean) ?? []
  );
}

function indexColumns(row: Record<string, unknown>, definition: string) {
  if (Array.isArray(row.columns)) {
    const columns = row.columns.map(String).filter(Boolean);
    if (columns.length) return columns;
  }
  return parsedIndexColumnsFromDefinition(definition);
}

function quoteSqlIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function sameColumns(left: string[], right: string[]) {
  return left.length === right.length && left.every((column, index) => column === right[index]);
}

export function publicConnection(input: ImportInput): ProjectConnection {
  const schema = input.schema || "public";
  const supabaseRef = input.supabaseUrl
    ? new URL(input.supabaseUrl).hostname.split(".")[0]
    : undefined;

  return {
    provider: input.supabaseUrl ? "supabase" : "postgres",
    name: input.supabaseUrl ? "Supabase" : "Postgres",
    supabaseUrl: input.supabaseUrl,
    host: input.host || (supabaseRef ? `db.${supabaseRef}.supabase.co` : undefined),
    port: input.port || 5432,
    database: input.database || "postgres",
    username: input.username || "postgres",
    schema,
    ssl: input.ssl ?? true,
  };
}

function poolConfig(input: ImportInput) {
  if (input.connectionString) {
    return {
      connectionString: input.ssl === false ? input.connectionString : connectionStringWithNoVerifySsl(input.connectionString),
      ssl: input.ssl === false ? false : { rejectUnauthorized: false },
    };
  }

  const connection = publicConnection(input);
  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: input.password,
    ssl: connection.ssl === false ? false : { rejectUnauthorized: false },
  };
}

async function readPostgresSchema(input: ImportInput) {
  const schemaName = input.schema || "public";
  const pool = new Pool(poolConfig(input));

  try {
    const [columnsResult, constraintsResult, foreignKeysResult, indexesResult] =
      await Promise.all([
        pool.query(
          `
          select table_schema, table_name, column_name, ordinal_position, data_type, udt_name,
                 is_nullable, column_default, character_maximum_length, numeric_precision, numeric_scale
          from information_schema.columns
          where table_schema = $1
          order by table_schema, table_name, ordinal_position
        `,
          [schemaName],
        ),
        pool.query(
          `
          select tc.constraint_name, tc.table_schema, tc.table_name, tc.constraint_type,
                 kcu.column_name, kcu.ordinal_position
          from information_schema.table_constraints tc
          join information_schema.key_column_usage kcu
            on tc.constraint_name = kcu.constraint_name
           and tc.table_schema = kcu.table_schema
           and tc.table_name = kcu.table_name
          where tc.table_schema = $1
            and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE')
          order by tc.table_name, tc.constraint_name, kcu.ordinal_position
        `,
          [schemaName],
        ),
        pool.query(
          `
          select con.conname, ns.nspname as table_schema, cl.relname as table_name,
                 att.attname as column_name, fns.nspname as foreign_table_schema,
                 fcl.relname as foreign_table_name, fatt.attname as foreign_column_name,
                 con.confdeltype, con.confupdtype
          from pg_constraint con
          join pg_class cl on cl.oid = con.conrelid
          join pg_namespace ns on ns.oid = cl.relnamespace
          join lateral unnest(con.conkey) with ordinality as cols(attnum, ord) on true
          join pg_attribute att on att.attrelid = cl.oid and att.attnum = cols.attnum
          join pg_class fcl on fcl.oid = con.confrelid
          join pg_namespace fns on fns.oid = fcl.relnamespace
          join lateral unnest(con.confkey) with ordinality as fcols(attnum, ord) on fcols.ord = cols.ord
          join pg_attribute fatt on fatt.attrelid = fcl.oid and fatt.attnum = fcols.attnum
          where con.contype = 'f'
            and ns.nspname = $1
          order by cl.relname, con.conname, cols.ord
        `,
          [schemaName],
        ),
        pool.query(
          `
          select ns.nspname as table_schema,
                 tbl.relname as table_name,
                 idx.relname as index_name,
                 pg_get_indexdef(idx.oid) as indexdef,
                 ix.indisunique,
                 ix.indisprimary,
                 coalesce(
                   array_agg(att.attname order by keys.ordinality) filter (where att.attname is not null),
                   array[]::text[]
                 ) as columns
          from pg_index ix
          join pg_class idx on idx.oid = ix.indexrelid
          join pg_class tbl on tbl.oid = ix.indrelid
          join pg_namespace ns on ns.oid = tbl.relnamespace
          left join lateral unnest(ix.indkey) with ordinality as keys(attnum, ordinality) on true
          left join pg_attribute att
            on att.attrelid = tbl.oid
           and att.attnum = keys.attnum
          where ns.nspname = $1
          group by ns.nspname, tbl.relname, idx.relname, idx.oid, ix.indisunique, ix.indisprimary
          order by tbl.relname, ix.indisprimary desc, idx.relname
        `,
          [schemaName],
        ),
      ]);

    const tablesByKey = new Map<string, DbTable>();
    const constraints = constraintsResult.rows as Array<Record<string, unknown>>;
    const uniqueColumns = new Set<string>();
    const pkColumns = new Set<string>();
    const indexConstraints = new Map<
      string,
      {
        name: string;
        schema: string;
        table: string;
        type: "PRIMARY KEY" | "UNIQUE";
        columns: string[];
      }
    >();

    constraints.forEach((constraint) => {
      const key = `${constraint.table_schema}.${constraint.table_name}.${constraint.column_name}`;
      if (constraint.constraint_type === "PRIMARY KEY") pkColumns.add(key);
      if (constraint.constraint_type === "UNIQUE") uniqueColumns.add(key);

      if (constraint.constraint_type !== "PRIMARY KEY" && constraint.constraint_type !== "UNIQUE") return;
      const constraintKey = `${constraint.table_schema}.${constraint.table_name}.${constraint.constraint_name}`;
      const indexConstraint =
        indexConstraints.get(constraintKey) ??
        {
          name: String(constraint.constraint_name),
          schema: String(constraint.table_schema),
          table: String(constraint.table_name),
          type: constraint.constraint_type as "PRIMARY KEY" | "UNIQUE",
          columns: [],
        };
      indexConstraint.columns[Number(constraint.ordinal_position) - 1] = String(constraint.column_name);
      indexConstraints.set(constraintKey, indexConstraint);
    });

    columnsResult.rows.forEach((row: Record<string, unknown>) => {
      const tableKey = `${row.table_schema}.${row.table_name}`;
      const columnKey = `${row.table_schema}.${row.table_name}.${row.column_name}`;

      if (!tablesByKey.has(tableKey)) {
        tablesByKey.set(tableKey, {
          id: id("tbl"),
          schema: String(row.table_schema),
          name: String(row.table_name),
          columns: [],
          indexes: [],
        });
      }

      const table = tablesByKey.get(tableKey)!;
      table.columns.push({
        id: id("col"),
        name: String(row.column_name),
        type: columnType(row),
        nullable: row.is_nullable === "YES",
        primaryKey: pkColumns.has(columnKey),
        unique: uniqueColumns.has(columnKey),
        defaultValue: row.column_default ? String(row.column_default) : undefined,
      });
    });

    const tables = Array.from(tablesByKey.values()).filter((table) => !isDbOpenStudioInternalTable(table.name));
    const byName = new Map(tables.map((table) => [`${table.schema}.${table.name}`, table]));
    const columnByName = new Map<string, DbColumn>();

    tables.forEach((table) => {
      table.columns.forEach((column) => {
        columnByName.set(`${table.schema}.${table.name}.${column.name}`, column);
      });
    });

    indexesResult.rows.forEach((row: Record<string, unknown>) => {
      const table = byName.get(`${row.table_schema}.${row.table_name}`);
      if (!table) return;

      const definition = String(row.indexdef);
      table.indexes.push({
        id: id("idx"),
        name: String(row.index_name),
        columns: indexColumns(row, definition),
        unique: row.indisunique === true,
        definition,
      });
    });

    indexConstraints.forEach((constraint) => {
      const table = byName.get(`${constraint.schema}.${constraint.table}`);
      if (!table) return;
      const columns = constraint.columns.filter(Boolean);
      const existing = table.indexes.some(
        (index) => index.name === constraint.name || (index.unique && sameColumns(index.columns, columns)),
      );
      if (existing) return;

      const quotedColumns = columns.map(quoteSqlIdentifier).join(", ");
      table.indexes.push({
        id: id("idx"),
        name: constraint.name,
        columns,
        unique: true,
        definition: `ALTER TABLE ${quoteSqlIdentifier(constraint.schema)}.${quoteSqlIdentifier(constraint.table)} ADD CONSTRAINT ${quoteSqlIdentifier(constraint.name)} ${constraint.type} (${quotedColumns});`,
      });
    });

    const relations: DbRelation[] = [];
    foreignKeysResult.rows.forEach((row: Record<string, unknown>) => {
      const fromTable = byName.get(`${row.table_schema}.${row.table_name}`);
      const toTable = byName.get(`${row.foreign_table_schema}.${row.foreign_table_name}`);
      if (!fromTable || !toTable) return;

      const fromColumn = columnByName.get(
        `${row.table_schema}.${row.table_name}.${row.column_name}`,
      );
      const toColumn = columnByName.get(
        `${row.foreign_table_schema}.${row.foreign_table_name}.${row.foreign_column_name}`,
      );
      if (!fromColumn || !toColumn) return;

      relations.push({
        id: id("rel"),
        name: String(row.conname),
        fromTableId: fromTable.id,
        fromColumnId: fromColumn.id,
        toTableId: toTable.id,
        toColumnId: toColumn.id,
        onDelete: mapAction(String(row.confdeltype)),
        onUpdate: mapAction(String(row.confupdtype)),
      });
    });

    const model: SchemaModel = {
      version: 1,
      schemas: [schemaName],
      tables,
      relations,
    };

    const canvas: CanvasModel = {
      nodes: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };

    return { model, canvas, connection: publicConnection(input) };
  } finally {
    await pool.end();
  }
}

export async function importPostgresSchema(input: ImportInput) {
  try {
    return await readPostgresSchema(input);
  } catch (error) {
    if (input.ssl === false || !isSslUnsupportedError(error)) {
      throw error;
    }

    return readPostgresSchema({ ...input, ssl: false });
  }
}
