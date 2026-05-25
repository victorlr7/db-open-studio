import type { CanvasModel, CanvasView, DbColumn, DbTable, SchemaModel, VisualProject, WorkspaceStore } from "./types";

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const DEFAULT_TABLE_NODE_WIDTH = 260;
export const DEFAULT_TABLE_NODE_HEIGHT = 90;

export function nowIso() {
  return new Date().toISOString();
}

export function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;
}

export function emptySchema(): SchemaModel {
  return {
    version: 1,
    schemas: ["public"],
    tables: [],
    relations: [],
  };
}

export function emptyCanvas(): CanvasModel {
  return {
    nodes: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export function createCanvasView(
  name = "Main view",
  canvas: CanvasModel = emptyCanvas(),
  overrides: Partial<CanvasView> = {},
): CanvasView {
  const timestamp = nowIso();
  return {
    id: id("view"),
    name,
    canvas: stripCanvasViewMetadata(canvas),
    isPrimary: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function stripCanvasViewMetadata(canvas: CanvasModel): CanvasModel {
  return {
    nodes: canvas.nodes ?? [],
    viewport: canvas.viewport ?? { x: 0, y: 0, zoom: 1 },
  };
}

export function normalizeProjectViews(project: VisualProject): VisualProject {
  const storedViews = project.views ?? project.canvas.views;
  const fallbackCanvas = stripCanvasViewMetadata(project.canvas ?? emptyCanvas());
  const views =
    storedViews && storedViews.length > 0
      ? storedViews.map((view, index) => ({
          ...view,
          isPrimary: index === 0 ? true : Boolean(view.isPrimary),
          canvas: stripCanvasViewMetadata(view.canvas),
        }))
      : [
          createCanvasView("Main view", fallbackCanvas, {
            isPrimary: true,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          }),
        ];
  const hasPrimary = views.some((view) => view.isPrimary);
  const normalizedViews = hasPrimary ? views : views.map((view, index) => ({ ...view, isPrimary: index === 0 }));
  const activeViewId =
    project.activeViewId ??
    project.canvas.activeViewId ??
    normalizedViews.find((view) => view.isPrimary)?.id ??
    normalizedViews[0].id;
  const activeView = normalizedViews.find((view) => view.id === activeViewId) ?? normalizedViews[0];

  return {
    ...project,
    canvas: activeView.canvas,
    views: normalizedViews,
    activeViewId: activeView.id,
  };
}

export function canvasWithViewMetadata(canvas: CanvasModel, views: CanvasView[], activeViewId?: string): CanvasModel {
  return {
    ...stripCanvasViewMetadata(canvas),
    views: views.map((view) => ({ ...view, canvas: stripCanvasViewMetadata(view.canvas) })),
    activeViewId,
  };
}

export function createColumn(name = "id", overrides: Partial<DbColumn> = {}): DbColumn {
  return {
    id: id("col"),
    name,
    type: "uuid",
    nullable: false,
    primaryKey: name === "id",
    unique: false,
    defaultValue: name === "id" ? "gen_random_uuid()" : undefined,
    ...overrides,
  };
}

export function createTable(name = "new_table", x = 120, y = 120) {
  const table: DbTable = {
    id: id("tbl"),
    schema: "public",
    name,
    columns: [createColumn()],
    indexes: [],
  };

  return {
    table,
    node: {
      id: table.id,
      position: { x, y },
      width: DEFAULT_TABLE_NODE_WIDTH,
      height: DEFAULT_TABLE_NODE_HEIGHT,
    },
  };
}

export function seedStore(): WorkspaceStore {
  const createdAt = nowIso();
  const userId = "usr_local";
  const schema = emptySchema();
  const canvas = emptyCanvas();
  const mainView = createCanvasView("Main view", canvas, {
    id: "view_local_main",
    isPrimary: true,
    createdAt,
    updatedAt: createdAt,
  });

  return {
    users: [
      {
        id: userId,
        name: "Local user",
        email: "local@dbopenstudio.dev",
        locale: "en",
        createdAt,
      },
    ],
    projects: [
      {
        id: "prj_supabase_demo",
        userId,
        name: "New project",
        description: "Local visual design.",
        model: schema,
        canvas,
        views: [mainView],
        activeViewId: mainView.id,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    migrations: [],
  };
}
