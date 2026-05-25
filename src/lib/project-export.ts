import { z } from "zod";
import type { GeneratedMigration, ProjectConnection, SchemaSnapshot, VisualProject } from "./types";

export const DBOPENSTUDIO_PROJECT_FORMAT = "dbopenstudio.project";
export const DBOPENSTUDIO_PROJECT_EXPORT_VERSION = 1;

const columnSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  nullable: z.boolean(),
  primaryKey: z.boolean(),
  unique: z.boolean(),
  defaultValue: z.string().optional(),
});

const indexSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  columns: z.array(z.string()),
  unique: z.boolean(),
  definition: z.string().optional(),
});

const tableSchema = z.object({
  id: z.string().min(1),
  schema: z.string().min(1),
  name: z.string().min(1),
  columns: z.array(columnSchema),
  indexes: z.array(indexSchema),
});

const relationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cardinality: z.enum(["one-to-many", "one-to-one"]).optional(),
  identifying: z.boolean().optional(),
  fromTableId: z.string().min(1),
  fromColumnId: z.string().min(1),
  toTableId: z.string().min(1),
  toColumnId: z.string().min(1),
  onDelete: z.enum(["no action", "restrict", "cascade", "set null", "set default"]).optional(),
  onUpdate: z.enum(["no action", "restrict", "cascade", "set null", "set default"]).optional(),
});

const schemaModelSchema = z.object({
  version: z.literal(1),
  schemas: z.array(z.string()),
  tables: z.array(tableSchema),
  relations: z.array(relationSchema),
});

const canvasNodeSchema = z.object({
  id: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }),
  width: z.number().optional(),
  height: z.number().optional(),
  collapsed: z.boolean().optional(),
});

const canvasModelSchema = z.object({
  nodes: z.array(canvasNodeSchema),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }),
});

const canvasViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  canvas: canvasModelSchema,
  isPrimary: z.boolean(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const connectionSchema = z.object({
  provider: z.enum(["supabase", "postgres"]),
  name: z.string(),
  supabaseUrl: z.string().optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  database: z.string().optional(),
  username: z.string().optional(),
  schema: z.string().optional(),
  ssl: z.boolean().optional(),
}) satisfies z.ZodType<ProjectConnection>;

const snapshotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  source: connectionSchema.optional(),
  schema: schemaModelSchema,
  importedAt: z.string().min(1),
}) satisfies z.ZodType<SchemaSnapshot>;

const exportedProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  aiContext: z.string().optional(),
  connection: connectionSchema.optional(),
  snapshot: snapshotSchema.optional(),
  model: schemaModelSchema,
  canvas: canvasModelSchema,
  views: z.array(canvasViewSchema).min(1),
  activeViewId: z.string().optional(),
  createdAt: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
});

const migrationSchema = z.object({
  name: z.string(),
  sql: z.string(),
  warnings: z.array(z.string()),
  aiDescription: z.string().optional(),
  aiDescriptionGeneratedAt: z.string().optional(),
  createdAt: z.string(),
});

export const projectExportSchema = z.object({
  format: z.literal(DBOPENSTUDIO_PROJECT_FORMAT),
  version: z.literal(DBOPENSTUDIO_PROJECT_EXPORT_VERSION),
  exportedAt: z.string().min(1),
  source: z
    .object({
      app: z.literal("DBOpenStudio"),
      url: z.string().optional(),
    })
    .optional(),
  project: exportedProjectSchema,
  migrations: z.array(migrationSchema).optional(),
});

export type DbOpenStudioProjectExport = z.infer<typeof projectExportSchema>;

function stripCanvasMetadata(project: VisualProject) {
  return {
    nodes: project.canvas.nodes,
    viewport: project.canvas.viewport,
  };
}

export function exportProject(project: VisualProject, migrations: GeneratedMigration[] = []): DbOpenStudioProjectExport {
  return {
    format: DBOPENSTUDIO_PROJECT_FORMAT,
    version: DBOPENSTUDIO_PROJECT_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      app: "DBOpenStudio",
      url: typeof window === "undefined" ? undefined : window.location.origin,
    },
    project: {
      name: project.name,
      description: project.description,
      aiContext: project.aiContext,
      connection: project.connection,
      snapshot: project.snapshot,
      model: project.model,
      canvas: stripCanvasMetadata(project),
      views: project.views ?? [],
      activeViewId: project.activeViewId,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    migrations: migrations.map((migration) => ({
      name: migration.name,
      sql: migration.sql,
      warnings: migration.warnings,
      aiDescription: migration.aiDescription,
      aiDescriptionGeneratedAt: migration.aiDescriptionGeneratedAt,
      createdAt: migration.createdAt,
    })),
  };
}

export function parseProjectExport(input: unknown) {
  const parsed = projectExportSchema.parse(input);
  const tableIds = new Set(parsed.project.model.tables.map((table) => table.id));
  const columnIds = new Set(parsed.project.model.tables.flatMap((table) => table.columns.map((column) => column.id)));

  parsed.project.model.relations.forEach((relation) => {
    if (!tableIds.has(relation.fromTableId) || !tableIds.has(relation.toTableId)) {
      throw new Error(`Relation ${relation.name} points to a missing table.`);
    }
    if (!columnIds.has(relation.fromColumnId) || !columnIds.has(relation.toColumnId)) {
      throw new Error(`Relation ${relation.name} points to a missing column.`);
    }
  });

  parsed.project.canvas.nodes.forEach((node) => {
    if (!tableIds.has(node.id)) throw new Error(`The canvas contains a missing table: ${node.id}.`);
  });

  parsed.project.views.forEach((view) => {
    view.canvas.nodes.forEach((node) => {
      if (!tableIds.has(node.id)) throw new Error(`View ${view.name} contains a missing table: ${node.id}.`);
    });
  });

  return parsed;
}
