import { randomUUID } from "node:crypto";
import { Pool, type QueryResult } from "pg";
import {
  canvasWithViewMetadata,
  createCanvasView,
  emptyCanvas,
  emptySchema,
  id,
  normalizeProjectViews,
  nowIso,
  stripCanvasViewMetadata,
} from "./defaults";
import { normalizeProjectAiContext } from "./ai-context";
import { getAppDatabaseUrl } from "./env";
import { normalizeLocale } from "./i18n";
import type {
  AppUser,
  CanvasModel,
  CanvasView,
  DbRelation,
  DbTable,
  GeneratedMigration,
  ProjectConnection,
  SchemaSnapshot,
  SchemaModel,
  VisualProject,
  WorkspaceStore,
} from "./types";

let pool: Pool | undefined;
let profileLocaleSupportEnsured = false;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizedProjectName(name: string) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function getPool() {
  const connectionString = getAppDatabaseUrl();
  if (!connectionString) {
    throw new Error("DBOPENSTUDIO_DATABASE_URL is not configured");
  }

  pool ??= new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  return pool;
}

async function ensureProfileLocaleSupport() {
  if (profileLocaleSupportEnsured) return;
  await getPool().query(
    `
    alter table public.dbos_profiles
      add column if not exists locale text not null default 'en';

    update public.dbos_profiles
    set locale = 'en'
    where locale not in ('en', 'es', 'ca');

    alter table public.dbos_profiles
      drop constraint if exists dbos_profiles_locale_check;

    alter table public.dbos_profiles
      add constraint dbos_profiles_locale_check check (locale in ('en', 'es', 'ca'));
  `,
  );
  profileLocaleSupportEnsured = true;
}

async function assertUniqueDbProjectName(ownerUserId: string, name: string, exceptProjectId?: string) {
  const result = await getPool().query(
    `
    select id
    from public.dbos_projects
    where user_id = $1
      and lower(regexp_replace(trim(name), '[[:space:]]+', ' ', 'g')) = $2
      and ($3::uuid is null or id <> $3::uuid)
    limit 1
  `,
    [ownerUserId, normalizedProjectName(name), exceptProjectId ?? null],
  );
  if (result.rows[0]) {
    throw new Error("A project with this name already exists.");
  }
}

type ProjectRow = {
  id: string;
  user_id: string;
  owner_name: string | null;
  owner_email: string | null;
  shared_user_ids: string[] | null;
  name: string;
  description: string | null;
  ai_context: string | null;
  active_view_id: string | null;
  created_at: string;
  updated_at: string;
  connection: ProjectConnection | null;
  snapshot_id: string | null;
  snapshot_name: string | null;
  snapshot_schema: SchemaModel | null;
  snapshot_imported_at: string | null;
  model_json: SchemaModel | null;
  canvas_json: CanvasModel | null;
};

type ProfileRow = {
  id: string;
  display_name: string | null;
  email: string | null;
  locale: string | null;
  created_at: string;
};

type HybridProjectState = {
  model: SchemaModel;
  canvas: CanvasModel;
};

type HybridTableRow = {
  project_id: string;
  table_id: string;
  schema_name: string;
  table_name: string;
};

type HybridColumnRow = {
  project_id: string;
  table_id: string;
  column_id: string;
  column_name: string;
  data_type: string;
  nullable: boolean;
  primary_key: boolean;
  is_unique: boolean;
  default_value: string | null;
};

type HybridIndexRow = {
  project_id: string;
  table_id: string;
  index_id: string;
  index_name: string;
  columns_json: string[] | unknown;
  is_unique: boolean;
  definition: string | null;
};

type HybridRelationRow = {
  project_id: string;
  relation_id: string;
  relation_name: string;
  cardinality: string | null;
  identifying: boolean | null;
  from_table_id: string;
  from_column_id: string;
  to_table_id: string;
  to_column_id: string;
  on_delete: string | null;
  on_update: string | null;
};

type HybridViewRow = {
  project_id: string;
  view_id: string;
  name: string;
  is_primary: boolean;
  viewport_json: CanvasModel["viewport"] | unknown;
  created_at: string;
  updated_at: string;
};

type HybridNodeRow = {
  project_id: string;
  view_id: string;
  table_id: string;
  x: string | number;
  y: string | number;
  width: string | number | null;
  height: string | number | null;
  collapsed: boolean | null;
};

function validCardinality(value: string | null): DbRelation["cardinality"] | undefined {
  return value === "one-to-many" || value === "one-to-one" ? value : undefined;
}

function validReferentialAction(value: string | null): DbRelation["onDelete"] | undefined {
  if (
    value === "no action" ||
    value === "restrict" ||
    value === "cascade" ||
    value === "set null" ||
    value === "set default"
  ) {
    return value;
  }
  return undefined;
}

function normalizedViewport(value: unknown): CanvasModel["viewport"] {
  if (!value || typeof value !== "object") return { x: 0, y: 0, zoom: 1 };
  const input = value as Partial<CanvasModel["viewport"]>;
  return {
    x: typeof input.x === "number" ? input.x : Number(input.x ?? 0),
    y: typeof input.y === "number" ? input.y : Number(input.y ?? 0),
    zoom: typeof input.zoom === "number" ? input.zoom : Number(input.zoom ?? 1),
  };
}

function dateString(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : nowIso();
}

function isMissingHybridSchemaError(error: unknown) {
  const code = (error as { code?: string })?.code;
  return code === "42P01" || code === "42703";
}

async function readHybridProjectStates(projectRows: ProjectRow[]): Promise<Map<string, HybridProjectState>> {
  const projectIds = projectRows.map((row) => row.id);
  const result = new Map<string, HybridProjectState>();
  if (!projectIds.length) return result;

  let queryResults: [
    QueryResult<HybridTableRow>,
    QueryResult<HybridColumnRow>,
    QueryResult<HybridIndexRow>,
    QueryResult<HybridRelationRow>,
    QueryResult<HybridViewRow>,
    QueryResult<HybridNodeRow>,
  ];

  try {
    queryResults = await Promise.all([
      getPool().query<HybridTableRow>(
        `
        select project_id::text, table_id, schema_name, table_name
        from public.dbos_project_model_tables
        where project_id = any($1::uuid[])
        order by project_id, position, table_name
      `,
        [projectIds],
      ),
      getPool().query<HybridColumnRow>(
        `
        select project_id::text, table_id, column_id, column_name, data_type, nullable,
               primary_key, is_unique, default_value
        from public.dbos_project_model_columns
        where project_id = any($1::uuid[])
        order by project_id, table_id, position, column_name
      `,
        [projectIds],
      ),
      getPool().query<HybridIndexRow>(
        `
        select project_id::text, table_id, index_id, index_name, columns_json, is_unique, definition
        from public.dbos_project_model_indexes
        where project_id = any($1::uuid[])
        order by project_id, table_id, position, index_name
      `,
        [projectIds],
      ),
      getPool().query<HybridRelationRow>(
        `
        select project_id::text, relation_id, relation_name, cardinality, identifying,
               from_table_id, from_column_id, to_table_id, to_column_id, on_delete, on_update
        from public.dbos_project_model_relations
        where project_id = any($1::uuid[])
        order by project_id, position, relation_name
      `,
        [projectIds],
      ),
      getPool().query<HybridViewRow>(
        `
        select project_id::text, view_id, name, is_primary, viewport_json, created_at, updated_at
        from public.dbos_project_canvas_views
        where project_id = any($1::uuid[])
        order by project_id, position, name
      `,
        [projectIds],
      ),
      getPool().query<HybridNodeRow>(
        `
        select project_id::text, view_id, table_id, x, y, width, height, collapsed
        from public.dbos_project_canvas_nodes
        where project_id = any($1::uuid[])
        order by project_id, view_id, position, table_id
      `,
        [projectIds],
      ),
    ]);
  } catch (error) {
    if (isMissingHybridSchemaError(error)) return result;
    throw error;
  }

  const [tablesResult, columnsResult, indexesResult, relationsResult, viewsResult, nodesResult] = queryResults as [
    { rows: HybridTableRow[] },
    { rows: HybridColumnRow[] },
    { rows: HybridIndexRow[] },
    { rows: HybridRelationRow[] },
    { rows: HybridViewRow[] },
    { rows: HybridNodeRow[] },
  ];

  const states = new Map<
    string,
    {
      schemas: Set<string>;
      tables: DbTable[];
      tablesById: Map<string, DbTable>;
      relations: DbRelation[];
      views: CanvasView[];
      viewsById: Map<string, CanvasView>;
    }
  >();

  projectRows.forEach((row) => {
    states.set(row.id, {
      schemas: new Set(["public"]),
      tables: [],
      tablesById: new Map(),
      relations: [],
      views: [],
      viewsById: new Map(),
    });
  });

  tablesResult.rows.forEach((row) => {
    const state = states.get(row.project_id);
    if (!state) return;
    state.schemas.add(row.schema_name);
    const table: DbTable = {
      id: row.table_id,
      schema: row.schema_name,
      name: row.table_name,
      columns: [],
      indexes: [],
    };
    state.tables.push(table);
    state.tablesById.set(table.id, table);
  });

  columnsResult.rows.forEach((row) => {
    const table = states.get(row.project_id)?.tablesById.get(row.table_id);
    if (!table) return;
    table.columns.push({
      id: row.column_id,
      name: row.column_name,
      type: row.data_type,
      nullable: row.nullable,
      primaryKey: row.primary_key,
      unique: row.is_unique,
      defaultValue: row.default_value ?? undefined,
    });
  });

  indexesResult.rows.forEach((row) => {
    const table = states.get(row.project_id)?.tablesById.get(row.table_id);
    if (!table) return;
    table.indexes.push({
      id: row.index_id,
      name: row.index_name,
      columns: Array.isArray(row.columns_json) ? row.columns_json.map(String) : [],
      unique: row.is_unique,
      definition: row.definition ?? undefined,
    });
  });

  relationsResult.rows.forEach((row) => {
    const state = states.get(row.project_id);
    if (!state) return;
    state.relations.push({
      id: row.relation_id,
      name: row.relation_name,
      cardinality: validCardinality(row.cardinality),
      identifying: row.identifying ?? undefined,
      fromTableId: row.from_table_id,
      fromColumnId: row.from_column_id,
      toTableId: row.to_table_id,
      toColumnId: row.to_column_id,
      onDelete: validReferentialAction(row.on_delete),
      onUpdate: validReferentialAction(row.on_update),
    });
  });

  viewsResult.rows.forEach((row) => {
    const state = states.get(row.project_id);
    if (!state) return;
    const view: CanvasView = {
      id: row.view_id,
      name: row.name,
      canvas: { nodes: [], viewport: normalizedViewport(row.viewport_json) },
      isPrimary: row.is_primary,
      createdAt: dateString(row.created_at),
      updatedAt: dateString(row.updated_at),
    };
    state.views.push(view);
    state.viewsById.set(view.id, view);
  });

  nodesResult.rows.forEach((row) => {
    const view = states.get(row.project_id)?.viewsById.get(row.view_id);
    if (!view) return;
    view.canvas.nodes.push({
      id: row.table_id,
      position: { x: Number(row.x), y: Number(row.y) },
      width: row.width == null ? undefined : Number(row.width),
      height: row.height == null ? undefined : Number(row.height),
      collapsed: row.collapsed ?? undefined,
    });
  });

  projectRows.forEach((row) => {
    const state = states.get(row.id);
    if (!state || (!state.tables.length && !state.views.length)) return;
    const model: SchemaModel = {
      version: 1,
      schemas: Array.from(state.schemas),
      tables: state.tables,
      relations: state.relations,
    };
    const activeViewId =
      row.active_view_id ??
      state.views.find((view) => view.isPrimary)?.id ??
      state.views[0]?.id;
    const activeView = state.views.find((view) => view.id === activeViewId) ?? state.views[0];
    const canvas = activeView
      ? canvasWithViewMetadata(activeView.canvas, state.views, activeView.id)
      : emptyCanvas();
    result.set(row.id, { model, canvas });
  });

  return result;
}

export async function upsertProfile(user: AppUser) {
  await ensureProfileLocaleSupport();
  await getPool().query(
    `
    insert into public.dbos_profiles (id, display_name, email, locale)
    values ($1, $2, $3, $4)
    on conflict (id) do update
      set display_name = excluded.display_name,
          email = coalesce(excluded.email, public.dbos_profiles.email),
          updated_at = now()
  `,
    [user.id, user.name, user.email ?? null, normalizeLocale(user.locale)],
  );
}

export async function readDbStore(user: AppUser): Promise<WorkspaceStore> {
  await upsertProfile(user);

  const [profileResult, projectsResult, migrationsResult] = await Promise.all([
    getPool().query<ProfileRow>(
      `
      select id, display_name, email, locale, created_at
      from public.dbos_profiles
      where id = $1
    `,
      [user.id],
    ),
    getPool().query<ProjectRow>(
      `
      select p.id, p.user_id, owner.display_name as owner_name, owner.email as owner_email,
             coalesce(members.shared_user_ids, '{}'::uuid[])::text[] as shared_user_ids,
             p.name, p.description, p.ai_context,
             to_jsonb(p)->>'active_view_id' as active_view_id,
             p.created_at, p.updated_at,
             c.public_config as connection,
             s.id as snapshot_id, s.name as snapshot_name, s.schema_json as snapshot_schema, s.imported_at as snapshot_imported_at,
             vm.model_json, vm.canvas_json
      from public.dbos_projects p
      left join public.dbos_profiles owner on owner.id = p.user_id
      left join lateral (
        select array_agg(pm.user_id) as shared_user_ids
        from public.dbos_project_members pm
        where pm.project_id = p.id
      ) members on true
      left join lateral (
        select public_config
        from public.dbos_project_connections
        where project_id = p.id
        order by updated_at desc
        limit 1
      ) c on true
      left join lateral (
        select id, name, schema_json, imported_at
        from public.dbos_schema_snapshots
        where project_id = p.id
        order by imported_at desc
        limit 1
      ) s on true
      left join lateral (
        select model_json, canvas_json
        from public.dbos_visual_models
        where project_id = p.id
        order by updated_at desc
        limit 1
      ) vm on true
      where p.user_id = $1
         or exists (
           select 1
           from public.dbos_project_members pm
           where pm.project_id = p.id and pm.user_id = $1
         )
      order by p.updated_at desc
    `,
      [user.id],
    ),
    getPool().query(
      `
      select m.id, coalesce((to_jsonb(m)->>'generated_by_user_id')::uuid, p.user_id)::text as generated_by_user_id,
        author.display_name as generated_by_name, author.email as generated_by_email,
        m.project_id, m.name, m.sql, m.warnings_json, m.diff_json,
        to_jsonb(m)->>'ai_description' as ai_description,
        to_jsonb(m)->>'ai_description_generated_at' as ai_description_generated_at,
        m.created_at
      from public.dbos_generated_migrations m
      join public.dbos_projects p on p.id = m.project_id
      left join public.dbos_profiles author on author.id = coalesce((to_jsonb(m)->>'generated_by_user_id')::uuid, p.user_id)
      where p.user_id = $1
         or exists (
           select 1
           from public.dbos_project_members pm
           where pm.project_id = p.id and pm.user_id = $1
         )
      order by m.created_at desc
      limit 20
    `,
      [user.id],
    ),
  ]);

  const profile = profileResult.rows[0];
  const appUser: AppUser = {
    id: user.id,
    name: profile?.display_name ?? user.name,
    email: user.email,
    locale: normalizeLocale(profile?.locale ?? user.locale),
    createdAt: profile?.created_at ?? user.createdAt,
  };

  const hybridStates = await readHybridProjectStates(projectsResult.rows);

  const projects: VisualProject[] = projectsResult.rows.map((row) => {
    const hybrid = hybridStates.get(row.id);
    return normalizeProjectViews(
      {
        id: row.id,
        userId: row.user_id,
        ownerName: row.owner_name ?? undefined,
        ownerEmail: row.owner_email ?? undefined,
        sharedUserIds: row.shared_user_ids ?? [],
        name: row.name,
        description: row.description ?? undefined,
        aiContext: row.ai_context ?? undefined,
        connection: row.connection ?? undefined,
        snapshot:
          row.snapshot_id && row.snapshot_schema && row.snapshot_imported_at
            ? {
                id: row.snapshot_id,
                name: row.snapshot_name ?? "Snapshot",
                source: row.connection ?? undefined,
                schema: row.snapshot_schema,
                importedAt: row.snapshot_imported_at,
              }
            : undefined,
        model: hybrid?.model ?? row.model_json ?? row.snapshot_schema ?? emptySchema(),
        canvas: hybrid?.canvas ?? row.canvas_json ?? emptyCanvas(),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    );
  });

  const migrations: GeneratedMigration[] = migrationsResult.rows.map((row) => ({
    id: row.id,
    userId: row.generated_by_user_id,
    userName: row.generated_by_name ?? undefined,
    userEmail: row.generated_by_email ?? undefined,
    projectId: row.project_id,
    name: row.name,
    sql: row.sql,
    warnings: row.warnings_json ?? [],
    summary: row.diff_json ?? { items: [], counts: {} },
    aiDescription: row.ai_description ?? undefined,
    aiDescriptionGeneratedAt: row.ai_description_generated_at ?? undefined,
    createdAt: row.created_at,
  }));

  return { users: [appUser], projects, migrations };
}

export async function createDbProject(user: AppUser, name: string): Promise<VisualProject> {
  await upsertProfile(user);
  const projectName = name.trim() || "New project";
  await assertUniqueDbProjectName(user.id, projectName);
  const result = await getPool().query(
    `
    insert into public.dbos_projects (user_id, name)
    values ($1, $2)
    returning id, user_id, name, description, created_at, updated_at
  `,
    [user.id, projectName],
  );
  const row = result.rows[0];
  const model = emptySchema();
  const canvas = emptyCanvas();
  const mainView = createCanvasView("Main view", canvas, {
    isPrimary: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  await saveDbVisualModel(row.id, "Current model", model, canvasWithViewMetadata(canvas, [mainView], mainView.id));

  return {
    id: row.id,
    userId: row.generated_by_user_id,
    ownerName: user.name,
    ownerEmail: user.email,
    sharedUserIds: [],
    name: row.name,
    description: row.description ?? undefined,
    model,
    canvas,
    views: [mainView],
    activeViewId: mainView.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createDbProjectCopy(user: AppUser, name: string, source: VisualProject): Promise<VisualProject> {
  await upsertProfile(user);
  const projectName = name.trim();
  if (!projectName) {
    throw new Error("Project name is required.");
  }
  await assertUniqueDbProjectName(user.id, projectName);
  const sourceProject = normalizeProjectViews(source);
  const result = await getPool().query(
    `
    insert into public.dbos_projects (user_id, name, description, ai_context)
    values ($1, $2, $3, $4)
    returning id, user_id, name, description, ai_context, created_at, updated_at
  `,
    [user.id, projectName, sourceProject.description ?? null, normalizeProjectAiContext(sourceProject.aiContext) ?? null],
  );
  const row = result.rows[0];
  const views = (sourceProject.views ?? []).map((view) => ({
    ...view,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  const activeViewId =
    views.find((view) => view.id === sourceProject.activeViewId)?.id ??
    views.find((view) => view.isPrimary)?.id ??
    views[0]?.id;

  if (sourceProject.connection) {
    await saveDbConnection(row.id, sourceProject.connection);
  }

  let snapshotId: string | undefined;
  if (sourceProject.snapshot) {
    const snapshotResult = await getPool().query(
      `
      insert into public.dbos_schema_snapshots (id, project_id, name, schema_json, imported_at)
      values ($1, $2, $3, $4::jsonb, $5)
      returning id
    `,
      [
        randomUUID(),
        row.id,
        sourceProject.snapshot.name,
        JSON.stringify(sourceProject.snapshot.schema),
        sourceProject.snapshot.importedAt,
      ],
    );
    snapshotId = snapshotResult.rows[0].id;
  }

  await saveDbVisualModel(
    row.id,
    "Current model",
    sourceProject.model,
    canvasWithViewMetadata(sourceProject.canvas, views, activeViewId),
    snapshotId,
  );

  const fresh = await readDbStore(user);
  const project = fresh.projects.find((item) => item.id === row.id);
  if (!project) throw new Error("Project not found after copy");
  return project;
}

async function saveDbConnection(projectId: string, connection: ProjectConnection) {
  await getPool().query(
    `
    insert into public.dbos_project_connections (project_id, provider, name, public_config)
    values ($1, $2, $3, $4::jsonb)
    on conflict (project_id) do update
      set provider = excluded.provider,
          name = excluded.name,
          public_config = excluded.public_config,
          updated_at = now()
  `,
    [projectId, connection.provider, connection.name, JSON.stringify(connection)],
  );
}

function canvasViewsForStorage(canvas: CanvasModel): CanvasView[] {
  if (canvas.views?.length) return canvas.views;
  return [
    createCanvasView("Main view", stripCanvasViewMetadata(canvas), {
      id: canvas.activeViewId ?? "view_main",
      isPrimary: true,
    }),
  ];
}

async function saveDbHybridProjectModel(projectId: string, model: SchemaModel, canvas: CanvasModel) {
  const views = canvasViewsForStorage(canvas);
  const activeViewId = canvas.activeViewId ?? views.find((view) => view.isPrimary)?.id ?? views[0]?.id;
  const tables = model.tables.map((table, position) => ({
    table_id: table.id,
    schema_name: table.schema,
    table_name: table.name,
    position,
  }));
  const columns = model.tables.flatMap((table) =>
    table.columns.map((column, position) => ({
      table_id: table.id,
      column_id: column.id,
      column_name: column.name,
      data_type: column.type,
      nullable: column.nullable,
      primary_key: column.primaryKey,
      is_unique: column.unique,
      default_value: column.defaultValue ?? null,
      position,
    })),
  );
  const indexes = model.tables.flatMap((table) =>
    table.indexes.map((index, position) => ({
      table_id: table.id,
      index_id: index.id,
      index_name: index.name,
      columns_json: index.columns,
      is_unique: index.unique,
      definition: index.definition ?? null,
      position,
    })),
  );
  const relations = model.relations.map((relation, position) => ({
    relation_id: relation.id,
    relation_name: relation.name || relation.id,
    cardinality: relation.cardinality ?? null,
    identifying: relation.identifying ?? null,
    from_table_id: relation.fromTableId,
    from_column_id: relation.fromColumnId,
    to_table_id: relation.toTableId,
    to_column_id: relation.toColumnId,
    on_delete: relation.onDelete ?? null,
    on_update: relation.onUpdate ?? null,
    position,
  }));
  const viewRows = views.map((view, position) => ({
    view_id: view.id,
    name: view.name,
    is_primary: view.isPrimary,
    viewport_json: view.canvas.viewport,
    position,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
  }));
  const nodeRows = views.flatMap((view) =>
    view.canvas.nodes.map((node, position) => ({
      view_id: view.id,
      table_id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: node.width ?? null,
      height: node.height ?? null,
      collapsed: node.collapsed ?? null,
      position,
    })),
  );

  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(`delete from public.dbos_project_canvas_nodes where project_id = $1`, [projectId]);
    await client.query(`delete from public.dbos_project_canvas_views where project_id = $1`, [projectId]);
    await client.query(`delete from public.dbos_project_model_relations where project_id = $1`, [projectId]);
    await client.query(`delete from public.dbos_project_model_tables where project_id = $1`, [projectId]);

    await client.query(
      `
      insert into public.dbos_project_model_tables (project_id, table_id, schema_name, table_name, position)
      select $1::uuid, table_id, schema_name, table_name, position
      from jsonb_to_recordset($2::jsonb) as x(table_id text, schema_name text, table_name text, position integer)
    `,
      [projectId, JSON.stringify(tables)],
    );

    await client.query(
      `
      insert into public.dbos_project_model_columns (
        project_id, table_id, column_id, column_name, data_type, nullable,
        primary_key, is_unique, default_value, position
      )
      select $1::uuid, table_id, column_id, column_name, data_type, nullable,
             primary_key, is_unique, default_value, position
      from jsonb_to_recordset($2::jsonb) as x(
        table_id text,
        column_id text,
        column_name text,
        data_type text,
        nullable boolean,
        primary_key boolean,
        is_unique boolean,
        default_value text,
        position integer
      )
    `,
      [projectId, JSON.stringify(columns)],
    );

    await client.query(
      `
      insert into public.dbos_project_model_indexes (
        project_id, table_id, index_id, index_name, columns_json,
        is_unique, definition, position
      )
      select $1::uuid, table_id, index_id, index_name, columns_json,
             is_unique, definition, position
      from jsonb_to_recordset($2::jsonb) as x(
        table_id text,
        index_id text,
        index_name text,
        columns_json jsonb,
        is_unique boolean,
        definition text,
        position integer
      )
    `,
      [projectId, JSON.stringify(indexes)],
    );

    await client.query(
      `
      insert into public.dbos_project_model_relations (
        project_id, relation_id, relation_name, cardinality, identifying,
        from_table_id, from_column_id, to_table_id, to_column_id,
        on_delete, on_update, position
      )
      select $1::uuid, relation_id, relation_name, cardinality, identifying,
             from_table_id, from_column_id, to_table_id, to_column_id,
             on_delete, on_update, position
      from jsonb_to_recordset($2::jsonb) as x(
        relation_id text,
        relation_name text,
        cardinality text,
        identifying boolean,
        from_table_id text,
        from_column_id text,
        to_table_id text,
        to_column_id text,
        on_delete text,
        on_update text,
        position integer
      )
    `,
      [projectId, JSON.stringify(relations)],
    );

    await client.query(
      `
      insert into public.dbos_project_canvas_views (
        project_id, view_id, name, is_primary, viewport_json, position, created_at, updated_at
      )
      select $1::uuid, view_id, name, is_primary, viewport_json, position, created_at, updated_at
      from jsonb_to_recordset($2::jsonb) as x(
        view_id text,
        name text,
        is_primary boolean,
        viewport_json jsonb,
        position integer,
        created_at timestamptz,
        updated_at timestamptz
      )
    `,
      [projectId, JSON.stringify(viewRows)],
    );

    await client.query(
      `
      insert into public.dbos_project_canvas_nodes (
        project_id, view_id, table_id, x, y, width, height, collapsed, position
      )
      select $1::uuid, view_id, table_id, x, y, width, height, collapsed, position
      from jsonb_to_recordset($2::jsonb) as x(
        view_id text,
        table_id text,
        x numeric,
        y numeric,
        width numeric,
        height numeric,
        collapsed boolean,
        position integer
      )
    `,
      [projectId, JSON.stringify(nodeRows)],
    );

    await client.query(
      `
      update public.dbos_projects
      set active_view_id = $2,
          model_revision = model_revision + 1,
          layout_revision = layout_revision + 1
      where id = $1
    `,
      [projectId, activeViewId ?? null],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    if (isMissingHybridSchemaError(error)) return;
    throw error;
  } finally {
    client.release();
  }
}

async function saveDbVisualModel(
  projectId: string,
  name: string,
  model: SchemaModel,
  canvas: CanvasModel,
  snapshotId?: string,
) {
  await saveDbHybridProjectModel(projectId, model, canvas);

  const existing = await getPool().query(
    `
    select id
    from public.dbos_visual_models
    where project_id = $1
    order by updated_at desc
    limit 1
  `,
    [projectId],
  );

  if (existing.rows[0]) {
    await getPool().query(
      `
      update public.dbos_visual_models
      set name = $2,
          model_json = $3::jsonb,
          canvas_json = $4::jsonb,
          base_snapshot_id = coalesce($5::uuid, base_snapshot_id),
          updated_at = now()
      where id = $1
    `,
      [existing.rows[0].id, name, JSON.stringify(model), JSON.stringify(canvas), snapshotId ?? null],
    );
    return existing.rows[0].id as string;
  }

  const result = await getPool().query(
    `
    insert into public.dbos_visual_models (project_id, base_snapshot_id, name, model_json, canvas_json)
    values ($1, $2, $3, $4::jsonb, $5::jsonb)
    returning id
  `,
    [projectId, snapshotId ?? null, name, JSON.stringify(model), JSON.stringify(canvas)],
  );
  return result.rows[0].id as string;
}

export async function updateDbProject(
  user: AppUser,
  projectId: string,
  input: Partial<
    Pick<VisualProject, "name" | "description" | "aiContext" | "model" | "canvas" | "views" | "activeViewId" | "connection" | "snapshot">
  >,
) {
  const current = await readDbStore(user);
  const existing = current.projects.find((project) => project.id === projectId);
  if (!existing) throw new Error("Project not found");

  const nextName = input.name ?? existing.name;
  if (input.name) {
    await assertUniqueDbProjectName(existing.userId, input.name, projectId);
  }
  const nextDescription = input.description ?? existing.description;
  const nextAiContext = input.aiContext !== undefined ? normalizeProjectAiContext(input.aiContext) : existing.aiContext;
  const nextModel = input.model ?? existing.model;
  const nextCanvas = input.canvas ?? existing.canvas;
  const nextActiveViewId = input.activeViewId ?? existing.activeViewId;
  const nextViews =
    input.views ??
    (existing.views ?? []).map((view) =>
      input.canvas && view.id === nextActiveViewId
        ? { ...view, canvas: nextCanvas, updatedAt: nowIso() }
        : view,
    );

  await getPool().query(
    `
    update public.dbos_projects
    set name = $2,
        description = $3,
        ai_context = $4,
        updated_at = now()
    where id = $1
  `,
    [projectId, nextName, nextDescription ?? null, nextAiContext ?? null],
  );

  if (input.connection) {
    await saveDbConnection(projectId, input.connection);
  }

  let snapshotId = input.snapshot?.id;
  if (input.snapshot) {
    const dbSnapshotId = UUID_PATTERN.test(input.snapshot.id) ? input.snapshot.id : randomUUID();
    const result = await getPool().query(
      `
      insert into public.dbos_schema_snapshots (id, project_id, name, schema_json, imported_at)
      values ($1, $2, $3, $4::jsonb, $5)
      on conflict (id) do update
        set name = excluded.name,
            schema_json = excluded.schema_json,
            imported_at = excluded.imported_at
      returning id
    `,
      [
        dbSnapshotId,
        projectId,
        input.snapshot.name,
        JSON.stringify(input.snapshot.schema),
        input.snapshot.importedAt,
      ],
    );
    snapshotId = result.rows[0].id;
  }

  await saveDbVisualModel(
    projectId,
    "Current model",
    nextModel,
    canvasWithViewMetadata(nextCanvas, nextViews, nextActiveViewId),
    snapshotId,
  );

  const fresh = await readDbStore(user);
  const project = fresh.projects.find((item) => item.id === projectId);
  if (!project) throw new Error("Project not found after update");
  return project;
}

export async function updateDbUser(user: AppUser, input: Partial<Pick<AppUser, "name" | "email" | "locale">>) {
  await upsertProfile(user);
  const locale = input.locale ? normalizeLocale(input.locale) : undefined;
  if (input.email) await assertDbUserEmailAvailable(user, input.email);

  if (input.name || locale) {
    await getPool().query(
      `
      update public.dbos_profiles
      set display_name = coalesce($2, display_name),
          locale = coalesce($3, locale),
          updated_at = now()
      where id = $1
    `,
      [user.id, input.name ?? null, locale ?? null],
    );
  }

  const store = await readDbStore({
    ...user,
    name: input.name ?? user.name,
    locale: locale ?? normalizeLocale(user.locale),
  });
  return store.users[0];
}

export async function assertDbUserEmailAvailable(user: AppUser, email: string) {
  await upsertProfile(user);
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return;
  const result = await getPool().query(
    `
    select 1
    from public.dbos_profiles
    where id <> $1
      and lower(email) = $2
    limit 1
  `,
    [user.id, normalizedEmail],
  );
  if (result.rowCount) {
    throw new Error("A user with this email already exists.");
  }
}

export async function saveDbSnapshot(
  user: AppUser,
  projectId: string,
  snapshot: SchemaSnapshot,
  connection?: ProjectConnection,
  canvas?: CanvasModel,
) {
  return updateDbProject(user, projectId, {
    snapshot,
    ...(connection ? { connection } : {}),
    model: snapshot.schema,
    canvas,
  });
}

export async function saveDbMigration(migration: GeneratedMigration) {
  await getPool().query(
    `
    insert into public.dbos_generated_migrations
      (id, project_id, generated_by_user_id, name, sql, warnings_json, diff_json, created_at)
    values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
  `,
    [
      migration.id,
      migration.projectId,
      migration.userId,
      migration.name,
      migration.sql,
      JSON.stringify(migration.warnings),
      JSON.stringify(migration.summary),
      migration.createdAt,
    ],
  );
  return migration;
}

export async function shareDbProject(user: AppUser, projectId: string, email: string) {
  await upsertProfile(user);
  const targetEmail = email.trim().toLowerCase();
  const project = (await readDbStore(user)).projects.find((item) => item.id === projectId);
  if (!project) throw new Error("Project not found.");
  if (project.userId !== user.id) throw new Error("Only the project owner can share this project.");

  const profileResult = await getPool().query<{ id: string }>(
    `
    select id
    from public.dbos_profiles
    where lower(email) = $1
    limit 1
  `,
    [targetEmail],
  );
  const target = profileResult.rows[0];
  if (!target) throw new Error("That user does not exist in the system.");
  if (target.id === user.id) throw new Error("The project owner already has access.");

  await getPool().query(
    `
    insert into public.dbos_project_members (project_id, user_id)
    values ($1, $2)
    on conflict (project_id, user_id) do nothing
  `,
    [projectId, target.id],
  );

  const fresh = await readDbStore(user);
  const nextProject = fresh.projects.find((item) => item.id === projectId);
  if (!nextProject) throw new Error("Project not found after sharing.");
  return nextProject;
}

export async function deleteOrUnlinkDbProject(user: AppUser, projectId: string) {
  await upsertProfile(user);
  const project = (await readDbStore(user)).projects.find((item) => item.id === projectId);
  if (!project) throw new Error("Project not found.");

  if (project.userId === user.id) {
    await getPool().query(`delete from public.dbos_projects where id = $1 and user_id = $2`, [projectId, user.id]);
    return { mode: "deleted" as const };
  }

  const result = await getPool().query(
    `
    delete from public.dbos_project_members
    where project_id = $1 and user_id = $2
    returning project_id
  `,
    [projectId, user.id],
  );
  if (!result.rows[0]) throw new Error("Project link not found.");
  return { mode: "unlinked" as const };
}

export async function updateDbMigrationAiDescription(
  user: AppUser,
  migrationId: string,
  description: string,
  generatedAt: string,
) {
  const result = await getPool().query(
    `
    update public.dbos_generated_migrations m
    set ai_description = $3,
        ai_description_generated_at = $4
    from public.dbos_projects p
    where m.id = $1
      and m.project_id = p.id
      and (
        p.user_id = $2
        or exists (
          select 1
          from public.dbos_project_members pm
          where pm.project_id = p.id and pm.user_id = $2
        )
      )
    returning m.id, coalesce(m.generated_by_user_id, p.user_id)::text as generated_by_user_id,
      m.project_id, m.name, m.sql, m.warnings_json, m.diff_json,
      m.ai_description, m.ai_description_generated_at, m.created_at
  `,
    [migrationId, user.id, description, generatedAt],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Migration not found.");
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    name: row.name,
    sql: row.sql,
    warnings: row.warnings_json ?? [],
    summary: row.diff_json ?? { items: [], counts: {} },
    aiDescription: row.ai_description ?? undefined,
    aiDescriptionGeneratedAt: row.ai_description_generated_at ?? undefined,
    createdAt: row.created_at,
  } satisfies GeneratedMigration;
}

export function newMigrationId() {
  return id("mig");
}

export function timestamp() {
  return nowIso();
}
