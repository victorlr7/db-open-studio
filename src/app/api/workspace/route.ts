import { NextResponse } from "next/server";
import { z } from "zod";
import { isSupabaseConfigured, userFromRequest } from "@/lib/auth";
import {
  assertDbUserEmailAvailable,
  createDbProject,
  createDbProjectCopy,
  deleteOrUnlinkDbProject,
  readDbStore,
  shareDbProject,
  updateDbProject,
  updateDbUser,
} from "@/lib/db-store";
import {
  createProject,
  createProjectCopy,
  createUser,
  deleteOrUnlinkProject,
  readStore,
  shareProject,
  updateProject,
  updateUser,
} from "@/lib/store";
import { locales } from "@/lib/i18n";
import type { VisualProject } from "@/lib/types";

const createUserSchema = z.object({
  action: z.literal("createUser"),
  name: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
});

const createProjectSchema = z.object({
  action: z.literal("createProject"),
  userId: z.string().min(1),
  name: z.string().min(1),
});

const duplicateProjectSchema = z.object({
  action: z.literal("duplicateProject"),
  userId: z.string().min(1),
  name: z.string().min(1),
  project: z.record(z.string(), z.unknown()),
});

const updateProjectSchema = z.object({
  action: z.literal("updateProject"),
  projectId: z.string().min(1),
  project: z.record(z.string(), z.unknown()),
});

const shareProjectSchema = z.object({
  action: z.literal("shareProject"),
  projectId: z.string().min(1),
  userId: z.string().min(1),
  email: z.string().email(),
});

const deleteProjectSchema = z.object({
  action: z.literal("deleteProject"),
  projectId: z.string().min(1),
  userId: z.string().min(1),
});

const updateUserSchema = z.object({
  action: z.literal("updateUser"),
  userId: z.string().min(1),
  user: z.object({
    locale: z.enum(locales).optional(),
    name: z.string().min(1).optional(),
    email: z.string().email().optional().or(z.literal("")),
  }),
});

const checkUserEmailSchema = z.object({
  action: z.literal("checkUserEmail"),
  userId: z.string().min(1),
  email: z.string().email(),
});

export async function GET(request: Request) {
  if (isSupabaseConfigured()) {
    const user = await userFromRequest(request);
    if (user) {
      const store = await readDbStore(user);
      return NextResponse.json(store);
    }
  }

  const store = await readStore();
  return NextResponse.json(store);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = z.object({ action: z.string() }).parse(body).action;
    const authUser = isSupabaseConfigured() ? await userFromRequest(request) : undefined;

    if (action === "createUser") {
      const input = createUserSchema.parse(body);
      const user = await createUser(input.name, input.email || undefined);
      return NextResponse.json({ user });
    }

    if (action === "createProject") {
      const input = createProjectSchema.parse(body);
      if (authUser) {
        const project = await createDbProject(authUser, input.name);
        return NextResponse.json({ project });
      }
      const project = await createProject(input.userId, input.name);
      return NextResponse.json({ project });
    }

    if (action === "duplicateProject") {
      const input = duplicateProjectSchema.parse(body);
      if (authUser) {
        const project = await createDbProjectCopy(authUser, input.name, input.project as VisualProject);
        return NextResponse.json({ project });
      }
      const project = await createProjectCopy(input.userId, input.name, input.project as VisualProject);
      return NextResponse.json({ project });
    }

    if (action === "updateUser") {
      const input = updateUserSchema.parse(body);
      if (authUser) {
        const user = await updateDbUser(authUser, input.user);
        return NextResponse.json({ user });
      }
      const user = await updateUser(input.userId, input.user);
      return NextResponse.json({ user });
    }

    if (action === "checkUserEmail") {
      const input = checkUserEmailSchema.parse(body);
      if (authUser) {
        await assertDbUserEmailAvailable(authUser, input.email);
        return NextResponse.json({ available: true });
      }
      const store = await readStore();
      const normalizedEmail = input.email.trim().toLowerCase();
      const duplicate = store.users.some(
        (user) => user.id !== input.userId && user.email?.trim().toLowerCase() === normalizedEmail,
      );
      if (duplicate) throw new Error("A user with this email already exists.");
      return NextResponse.json({ available: true });
    }

    if (action === "updateProject") {
      const input = updateProjectSchema.parse(body);
      if (authUser) {
        const project = await updateDbProject(authUser, input.projectId, input.project);
        return NextResponse.json({ project });
      }
      const project = await updateProject(input.projectId, input.project);
      return NextResponse.json({ project });
    }

    if (action === "shareProject") {
      const input = shareProjectSchema.parse(body);
      if (authUser) {
        const project = await shareDbProject(authUser, input.projectId, input.email);
        return NextResponse.json({ project });
      }
      const project = await shareProject(input.projectId, input.userId, input.email);
      return NextResponse.json({ project });
    }

    if (action === "deleteProject") {
      const input = deleteProjectSchema.parse(body);
      if (authUser) {
        const result = await deleteOrUnlinkDbProject(authUser, input.projectId);
        return NextResponse.json(result);
      }
      const result = await deleteOrUnlinkProject(input.projectId, input.userId);
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unexpected error" },
      { status: 400 },
    );
  }
}
