import { NextResponse } from "next/server";
import { z } from "zod";
import { isSupabaseConfigured, userFromRequest } from "@/lib/auth";
import { readDbStore, saveDbMigration } from "@/lib/db-store";
import { generateMigration } from "@/lib/diff";
import { readStore, saveMigration } from "@/lib/store";

const schema = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    const authUser = isSupabaseConfigured() ? await userFromRequest(request) : undefined;
    const store = authUser ? await readDbStore(authUser) : await readStore();
    const project = store.projects.find((item) => item.id === input.projectId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const migration = {
      ...generateMigration(project),
      userId: authUser?.id ?? input.userId ?? project.userId,
      userName: authUser?.name,
      userEmail: authUser?.email,
    };
    if (!authUser) {
      const author = store.users.find((user) => user.id === migration.userId);
      migration.userName = author?.name;
      migration.userEmail = author?.email;
    }
    if (authUser) {
      await saveDbMigration(migration);
    } else {
      await saveMigration(migration);
    }

    return NextResponse.json({ migration });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not generate the migration." },
      { status: 400 },
    );
  }
}
