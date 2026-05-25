import type { Locale } from "./i18n";

export type ColumnType =
  | "uuid"
  | "text"
  | "varchar"
  | "integer"
  | "bigint"
  | "numeric"
  | "boolean"
  | "date"
  | "timestamp"
  | "timestamptz"
  | "jsonb"
  | "foreign";

export type DbColumn = {
  id: string;
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  defaultValue?: string;
};

export type DbIndex = {
  id: string;
  name: string;
  columns: string[];
  unique: boolean;
  definition?: string;
};

export type DbTable = {
  id: string;
  schema: string;
  name: string;
  columns: DbColumn[];
  indexes: DbIndex[];
};

export type DbRelation = {
  id: string;
  name: string;
  cardinality?: "one-to-many" | "one-to-one";
  identifying?: boolean;
  fromTableId: string;
  fromColumnId: string;
  toTableId: string;
  toColumnId: string;
  onDelete?: "no action" | "restrict" | "cascade" | "set null" | "set default";
  onUpdate?: "no action" | "restrict" | "cascade" | "set null" | "set default";
};

export type SchemaModel = {
  version: 1;
  schemas: string[];
  tables: DbTable[];
  relations: DbRelation[];
};

export type CanvasNode = {
  id: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  collapsed?: boolean;
};

export type CanvasView = {
  id: string;
  name: string;
  canvas: CanvasModel;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CanvasModel = {
  nodes: CanvasNode[];
  viewport: { x: number; y: number; zoom: number };
  views?: CanvasView[];
  activeViewId?: string;
};

export type AppUser = {
  id: string;
  name: string;
  email?: string;
  locale: Locale;
  createdAt: string;
};

export type ProjectConnection = {
  provider: "supabase" | "postgres";
  name: string;
  supabaseUrl?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  schema?: string;
  ssl?: boolean;
};

export type SchemaSnapshot = {
  id: string;
  name: string;
  source?: ProjectConnection;
  schema: SchemaModel;
  importedAt: string;
};

export type VisualProject = {
  id: string;
  userId: string;
  ownerName?: string;
  ownerEmail?: string;
  sharedUserIds?: string[];
  name: string;
  description?: string;
  aiContext?: string;
  connection?: ProjectConnection;
  snapshot?: SchemaSnapshot;
  model: SchemaModel;
  canvas: CanvasModel;
  views?: CanvasView[];
  activeViewId?: string;
  createdAt: string;
  updatedAt: string;
};

export type GeneratedMigration = {
  id: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  projectId: string;
  name: string;
  sql: string;
  warnings: string[];
  summary: DiffSummary;
  aiDescription?: string;
  aiDescriptionGeneratedAt?: string;
  createdAt: string;
};

export type WorkspaceStore = {
  users: AppUser[];
  projects: VisualProject[];
  migrations: GeneratedMigration[];
};

export type DiffItem =
  | { type: "added_table"; table: DbTable }
  | { type: "removed_table"; table: DbTable }
  | { type: "added_column"; table: DbTable; column: DbColumn }
  | { type: "removed_column"; table: DbTable; column: DbColumn }
  | {
      type: "modified_column";
      table: DbTable;
      before: DbColumn;
      after: DbColumn;
      changes: string[];
    }
  | { type: "added_relation"; relation: DbRelation }
  | { type: "removed_relation"; relation: DbRelation };

export type DiffSummary = {
  items: DiffItem[];
  counts: Record<string, number>;
};
