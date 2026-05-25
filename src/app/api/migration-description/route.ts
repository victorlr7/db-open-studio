import { NextResponse } from "next/server";
import { z } from "zod";
import { isSupabaseConfigured, userFromRequest } from "@/lib/auth";
import { readDbStore, updateDbMigrationAiDescription } from "@/lib/db-store";
import { locales, normalizeLocale, type Locale } from "@/lib/i18n";
import { buildMigrationReviewInput } from "@/lib/migration-ai-context";
import { readStore, updateMigrationAiDescription } from "@/lib/store";

const requestSchema = z.object({
  migrationId: z.string().min(1),
  projectId: z.string().min(1),
  locale: z.enum(locales).optional(),
});

function responseLanguage(locale: Locale) {
  if (locale === "es") return "Spanish";
  if (locale === "ca") return "Catalan";
  return "English";
}

function isAiEnabled() {
  return process.env.NEXT_PUBLIC_DBOPENSTUDIO_AI_ENABLED === "true";
}

function localizedError(locale: Locale, key: "aiDisabled" | "apiKey" | "notFound" | "contextWindow" | "requestFailed" | "empty") {
  const messages: Record<Locale, Record<typeof key, string>> = {
    en: {
      aiDisabled: "AI is disabled. Set NEXT_PUBLIC_DBOPENSTUDIO_AI_ENABLED=true.",
      apiKey: "OPENAI_API_KEY is not configured.",
      notFound: "Migration not found.",
      contextWindow: "The migration is too large for the selected AI model context. Reduce the context or use a model with a larger context window.",
      requestFailed: "Could not complete the OpenAI request.",
      empty: "OpenAI did not return a description.",
    },
    es: {
      aiDisabled: "La AI está desactivada. Configura NEXT_PUBLIC_DBOPENSTUDIO_AI_ENABLED=true.",
      apiKey: "OPENAI_API_KEY no está configurada.",
      notFound: "No se encontró la migración.",
      contextWindow: "La migración es demasiado grande para el contexto del modelo AI seleccionado. Reduce el contexto o usa un modelo con una ventana de contexto mayor.",
      requestFailed: "No se pudo completar la petición a OpenAI.",
      empty: "OpenAI no devolvió ninguna descripción.",
    },
    ca: {
      aiDisabled: "L'AI està desactivada. Configura NEXT_PUBLIC_DBOPENSTUDIO_AI_ENABLED=true.",
      apiKey: "OPENAI_API_KEY no està configurada.",
      notFound: "No s'ha trobat la migració.",
      contextWindow: "La migració és massa gran per al context del model AI seleccionat. Redueix el context o utilitza un model amb una finestra de context més gran.",
      requestFailed: "No s'ha pogut completar la petició a OpenAI.",
      empty: "OpenAI no ha retornat cap descripció.",
    },
  };

  return messages[locale][key];
}

function localizedOpenAiError(locale: Locale, message: string | undefined) {
  const normalized = message?.toLowerCase() ?? "";
  if (normalized.includes("context window") || normalized.includes("exceeds the context")) {
    return localizedError(locale, "contextWindow");
  }
  return locale === "en" && message ? message : localizedError(locale, "requestFailed");
}

function extractResponseText(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;
  const response = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  if (typeof response.output_text === "string") return response.output_text;
  return response.output
    ?.flatMap((item) => item.content ?? [])
    .find((part) => part.type === "output_text" && typeof part.text === "string")?.text;
}

export async function POST(request: Request) {
  let locale: Locale = "en";
  if (!isAiEnabled()) {
    return NextResponse.json({ error: localizedError(locale, "aiDisabled") }, { status: 403 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: localizedError(locale, "apiKey") }, { status: 500 });
  }

  try {
    const authUser = isSupabaseConfigured() ? await userFromRequest(request) : undefined;
    const input = requestSchema.parse(await request.json());
    locale = normalizeLocale(input.locale);
    const store = authUser ? await readDbStore(authUser) : await readStore();
    const project = store.projects.find((item) => item.id === input.projectId);
    const migration = store.migrations.find((item) => item.id === input.migrationId && item.projectId === input.projectId);

    if (!project || !migration) {
      return NextResponse.json({ error: localizedError(locale, "notFound") }, { status: 404 });
    }

    if (migration.aiDescription?.trim()) {
      return NextResponse.json({ migration });
    }

    const model = process.env.OPENAI_MODEL || "gpt-5-mini";
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        instructions: [
          "You are DBOpenStudio's migration reviewer.",
          `Write the entire migration review in ${responseLanguage(locale)}, matching the requesting user's UI language.`,
          "Generate Markdown only. Do not wrap it in a code block.",
          "Every visible word in the review must be in the requested language, including headings, table headers, risk labels, verdict text, and fallback sentences.",
          "The goal is not to explain every SQL statement line by line.",
          "The goal is to help a developer quickly understand what changed, affected tables, relationship changes, destructive risk, data impact, and manual checks before applying the migration.",
          "Be direct, technical, concise, and easy to scan. Avoid filler, duplicated information, and long paragraphs.",
          "Do not invent risks or facts that are not supported by the supplied SQL, diff summary, warnings, or project context.",
          "Use backticks for table names, column names, constraint names, and SQL identifiers.",
          "Use this semantic Markdown structure, translating all headings and table headers naturally into the requested language: # Summary, ## Main changes, ## Affected tables, ## Relationships, ## Impact on existing data, ## Manual review, ## Verdict.",
          "Under the Summary section, write one or two short sentences.",
          "Under the Main changes section, use Markdown bullets and group related changes. Do not list every SQL statement if it adds noise.",
          "Under the Affected tables section, use a Markdown table with three translated columns equivalent to: Table, Change, Risk.",
          "Risk values in the table must be translated equivalents of Low, Medium, or High in the requested language.",
          "Under the Relationships section, list only relationships created, removed, or modified using `source_table.source_column` → `target_table.target_column`.",
          "If there are no relationship changes, write one short sentence in the requested language saying that no relationships are created, removed, or modified.",
          "Under the Impact on existing data section, mention nullable columns, NOT NULL columns, removed columns, renamed columns, type changes, foreign keys that could fail because of existing data, data loss, and backfilling only when relevant.",
          "If impact cannot be determined from SQL and context, write one short sentence in the requested language saying that it cannot be determined from the available SQL and project context.",
          "Under the Manual review section, include only useful practical checks as Markdown bullets. Do not add generic advice.",
          "Under the Verdict section, use one short translated verdict equivalent to one of: Safe to apply; Probably safe, review X; Risky, review carefully; Destructive migration. Add one short reason.",
          "High risk: DROP TABLE, DROP COLUMN, destructive ALTER COLUMN TYPE, SET NOT NULL on existing populated tables, adding foreign keys over existing non-null data, DELETE or UPDATE statements affecting existing data, risky table or column renames, removing critical indexes, or changing unique constraints that affect application logic.",
          "Medium risk: adding foreign keys, adding unique constraints, adding NOT NULL columns with defaults, changing indexes on large tables, changing default values, adding cascade rules, or constraints against unusual or non-primary-key columns.",
          "Low risk: adding nullable columns, adding normal indexes, creating new empty tables, adding optional relationships, adding comments or metadata.",
          "If warnings are provided and empty, mention that only if it is relevant to the verdict.",
        ].join("\n"),
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify(buildMigrationReviewInput(project, migration)),
              },
            ],
          },
        ],
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      const message =
        typeof payload?.error?.message === "string" ? payload.error.message : undefined;
      return NextResponse.json({ error: localizedOpenAiError(locale, message) }, { status: response.status });
    }

    const description = extractResponseText(payload)?.trim();
    if (!description) {
      return NextResponse.json({ error: localizedError(locale, "empty") }, { status: 502 });
    }

    const generatedAt = new Date().toISOString();
    const updatedMigration = authUser
      ? await updateDbMigrationAiDescription(authUser, migration.id, description, generatedAt)
      : await updateMigrationAiDescription(migration.id, description, generatedAt);

    return NextResponse.json({ migration: updatedMigration });
  } catch (error) {
    return NextResponse.json(
      { error: locale === "en" && error instanceof Error ? error.message : localizedError(locale, "requestFailed") },
      { status: 400 },
    );
  }
}
