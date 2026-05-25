import { promises as fs } from "node:fs";
import path from "node:path";
import {
  canvasWithViewMetadata,
  createCanvasView,
  emptyCanvas,
  emptySchema,
  id,
  normalizeProjectViews,
  nowIso,
  seedStore,
} from "./defaults";
import { normalizeProjectAiContext } from "./ai-context";
import { normalizeLocale } from "./i18n";
import type {
  AppUser,
  CanvasModel,
  GeneratedMigration,
  ProjectConnection,
  SchemaSnapshot,
  VisualProject,
  WorkspaceStore,
} from "./types";

const configuredStorePath = process.env.DBOPENSTUDIO_LOCAL_STORE_PATH;
const storePath = configuredStorePath
  ? path.resolve(/* turbopackIgnore: true */ process.cwd(), configuredStorePath)
  : path.join(process.cwd(), "data", "dbopenstudio.json");

function normalizedProjectName(name: string) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function assertUniqueProjectName(store: WorkspaceStore, userId: string, name: string, exceptProjectId?: string) {
  const normalizedName = normalizedProjectName(name);
  const duplicate = store.projects.some(
    (project) =>
      project.userId === userId &&
      project.id !== exceptProjectId &&
      normalizedProjectName(project.name) === normalizedName,
  );
  if (duplicate) {
    throw new Error("A project with this name already exists.");
  }
}

function assertUniqueUserEmail(store: WorkspaceStore, email: string | undefined, exceptUserId: string) {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) return;
  const duplicate = store.users.some(
    (user) => user.id !== exceptUserId && user.email?.trim().toLowerCase() === normalizedEmail,
  );
  if (duplicate) {
    throw new Error("A user with this email already exists.");
  }
}

function canAccessProject(project: VisualProject, userId: string) {
  return project.userId === userId || Boolean(project.sharedUserIds?.includes(userId));
}

async function ensureStore() {
  await fs.mkdir(path.dirname(storePath), { recursive: true });

  try {
    await fs.access(storePath);
  } catch {
    await fs.writeFile(storePath, JSON.stringify(seedStore(), null, 2), "utf8");
  }
}

export async function readStore(): Promise<WorkspaceStore> {
  await ensureStore();
  const raw = await fs.readFile(storePath, "utf8");
  const store = JSON.parse(raw) as WorkspaceStore;
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  return {
    ...store,
    users: store.users.map((user) => ({ ...user, locale: normalizeLocale(user.locale) })),
    projects: store.projects.map((project) => {
      const owner = usersById.get(project.userId);
      return normalizeProjectViews({
        ...project,
        ownerName: project.ownerName ?? owner?.name,
        ownerEmail: project.ownerEmail ?? owner?.email,
        sharedUserIds: project.sharedUserIds ?? [],
      });
    }),
  };
}

export async function writeStore(store: WorkspaceStore) {
  await ensureStore();
  await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
  return store;
}

export async function createUser(name: string, email?: string): Promise<AppUser> {
  const store = await readStore();
  const user: AppUser = {
    id: id("usr"),
    name: name.trim() || "User",
    email: email?.trim() || undefined,
    locale: "en",
    createdAt: nowIso(),
  };

  store.users.push(user);
  await writeStore(store);
  return user;
}

export async function createProject(userId: string, name: string): Promise<VisualProject> {
  const store = await readStore();
  const projectName = name.trim() || "New project";
  assertUniqueProjectName(store, userId, projectName);
  const createdAt = nowIso();
  const canvas = emptyCanvas();
  const mainView = createCanvasView("Main view", canvas, {
    isPrimary: true,
    createdAt,
    updatedAt: createdAt,
  });
  const project: VisualProject = {
    id: id("prj"),
    userId,
    sharedUserIds: [],
    name: projectName,
    model: emptySchema(),
    canvas,
    views: [mainView],
    activeViewId: mainView.id,
    createdAt,
    updatedAt: createdAt,
  };

  store.projects.push(project);
  await writeStore(store);
  return project;
}

export async function createProjectCopy(userId: string, name: string, source: VisualProject): Promise<VisualProject> {
  const store = await readStore();
  const projectName = name.trim();
  if (!projectName) {
    throw new Error("Project name is required.");
  }
  assertUniqueProjectName(store, userId, projectName);
  const createdAt = nowIso();
  const sourceProject = normalizeProjectViews(source);
  const views = (sourceProject.views ?? []).map((view) => ({
    ...view,
    createdAt,
    updatedAt: createdAt,
  }));
  const activeViewId =
    views.find((view) => view.id === sourceProject.activeViewId)?.id ??
    views.find((view) => view.isPrimary)?.id ??
    views[0]?.id;
  const canvas = canvasWithViewMetadata(sourceProject.canvas, views, activeViewId);
  const project = normalizeProjectViews({
    ...sourceProject,
    id: id("prj"),
    userId,
    sharedUserIds: [],
    name: projectName,
    aiContext: normalizeProjectAiContext(sourceProject.aiContext),
    canvas,
    views,
    activeViewId,
    createdAt,
    updatedAt: createdAt,
  });

  store.projects.push(project);
  await writeStore(store);
  return project;
}

export async function updateUser(userId: string, input: Partial<Pick<AppUser, "name" | "email" | "locale">>) {
  const store = await readStore();
  const index = store.users.findIndex((user) => user.id === userId);
  if (index === -1) {
    throw new Error("User not found");
  }
  assertUniqueUserEmail(store, input.email, userId);

  store.users[index] = {
    ...store.users[index],
    ...input,
    locale: input.locale ? normalizeLocale(input.locale) : store.users[index].locale,
  };

  await writeStore(store);
  return store.users[index];
}

export async function updateProject(
  projectId: string,
  input: Partial<
    Pick<VisualProject, "name" | "description" | "aiContext" | "model" | "canvas" | "views" | "activeViewId" | "connection" | "snapshot">
  >,
) {
  const store = await readStore();
  const index = store.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error("Project not found");
  }

  const existing = normalizeProjectViews(store.projects[index]);
  if (input.name) {
    assertUniqueProjectName(store, existing.userId, input.name, projectId);
  }
  const nextActiveViewId = input.activeViewId ?? existing.activeViewId;
  const nextCanvas = input.canvas ?? existing.canvas;
  const nextViews =
    input.views ??
    (existing.views ?? []).map((view) =>
      input.canvas && view.id === nextActiveViewId
        ? { ...view, canvas: nextCanvas, updatedAt: nowIso() }
        : view,
    );

  store.projects[index] = normalizeProjectViews({
    ...existing,
    ...input,
    aiContext: input.aiContext !== undefined ? normalizeProjectAiContext(input.aiContext) : existing.aiContext,
    canvas: canvasWithViewMetadata(nextCanvas, nextViews ?? [], nextActiveViewId),
    views: nextViews,
    activeViewId: nextActiveViewId,
    updatedAt: nowIso(),
  });

  store.projects[index] = {
    ...store.projects[index],
    canvas: canvasWithViewMetadata(
      store.projects[index].canvas,
      store.projects[index].views ?? [],
      store.projects[index].activeViewId,
    ),
  };

  await writeStore(store);
  return store.projects[index];
}

export async function saveSnapshot(
  projectId: string,
  snapshot: SchemaSnapshot,
  connection?: ProjectConnection,
  canvas?: CanvasModel,
) {
  return updateProject(projectId, {
    snapshot,
    ...(connection ? { connection } : {}),
    model: snapshot.schema,
    canvas,
  });
}

export async function saveMigration(migration: GeneratedMigration) {
  const store = await readStore();
  store.migrations.unshift(migration);
  await writeStore(store);
  return migration;
}

export async function shareProject(projectId: string, ownerUserId: string, email: string): Promise<VisualProject> {
  const store = await readStore();
  const index = store.projects.findIndex((project) => project.id === projectId);
  if (index === -1) throw new Error("Project not found.");
  const project = store.projects[index];
  if (project.userId !== ownerUserId) throw new Error("Only the project owner can share this project.");

  const targetEmail = email.trim().toLowerCase();
  const targetUser = store.users.find((user) => user.email?.toLowerCase() === targetEmail);
  if (!targetUser) throw new Error("That user does not exist in the system.");
  if (targetUser.id === ownerUserId) throw new Error("The project owner already has access.");

  store.projects[index] = {
    ...project,
    sharedUserIds: Array.from(new Set([...(project.sharedUserIds ?? []), targetUser.id])),
    updatedAt: nowIso(),
  };
  await writeStore(store);
  return store.projects[index];
}

export async function deleteOrUnlinkProject(projectId: string, userId: string) {
  const store = await readStore();
  const project = store.projects.find((item) => item.id === projectId);
  if (!project || !canAccessProject(project, userId)) throw new Error("Project not found.");

  if (project.userId === userId) {
    await writeStore({
      ...store,
      projects: store.projects.filter((item) => item.id !== projectId),
      migrations: store.migrations.filter((migration) => migration.projectId !== projectId),
    });
    return { mode: "deleted" as const };
  }

  await writeStore({
    ...store,
    projects: store.projects.map((item) =>
      item.id === projectId
        ? { ...item, sharedUserIds: (item.sharedUserIds ?? []).filter((sharedUserId) => sharedUserId !== userId) }
        : item,
    ),
  });
  return { mode: "unlinked" as const };
}

export async function updateMigrationAiDescription(migrationId: string, description: string, generatedAt: string) {
  const store = await readStore();
  const index = store.migrations.findIndex((migration) => migration.id === migrationId);
  if (index === -1) throw new Error("Migration not found.");
  store.migrations[index] = {
    ...store.migrations[index],
    aiDescription: description,
    aiDescriptionGeneratedAt: generatedAt,
  };
  await writeStore(store);
  return store.migrations[index];
}
