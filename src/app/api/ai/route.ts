import { NextResponse } from "next/server";
import { z } from "zod";
import type { AiProposal } from "@/lib/ai-changes";
import { normalizeProjectAiContext } from "@/lib/ai-context";
import {
  buildAiModelContext,
  buildAiPlannerContext,
  type AiContextPlan,
} from "@/lib/ai-model-context";
import { normalizeAiProposalPayload } from "@/lib/ai-proposal";
import { isSupabaseConfigured, userFromRequest } from "@/lib/auth";
import { locales, normalizeLocale, type Locale } from "@/lib/i18n";
import type { VisualProject } from "@/lib/types";

const columnSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  nullable: z.boolean().optional(),
  primaryKey: z.boolean().optional(),
  unique: z.boolean().optional(),
  defaultValue: z.string().nullable().optional(),
});

const changeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_table"),
    schema: z.string().optional(),
    name: z.string().min(1),
    columns: z.array(columnSchema).optional(),
    visible: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("add_column"),
    tableId: z.string().optional(),
    tableName: z.string().optional(),
    column: columnSchema,
  }),
  z.object({
    type: z.literal("update_column"),
    tableId: z.string().optional(),
    tableName: z.string().optional(),
    columnId: z.string().optional(),
    columnName: z.string().optional(),
    patch: columnSchema.partial(),
  }),
  z.object({
    type: z.literal("remove_column"),
    tableId: z.string().optional(),
    tableName: z.string().optional(),
    columnId: z.string().optional(),
    columnName: z.string().optional(),
  }),
  z.object({
    type: z.literal("remove_table"),
    tableId: z.string().optional(),
    tableName: z.string().optional(),
  }),
  z.object({
    type: z.literal("add_relation"),
    name: z.string().optional(),
    fromTableId: z.string().optional(),
    fromTableName: z.string().optional(),
    fromColumnId: z.string().optional(),
    fromColumnName: z.string().optional(),
    toTableId: z.string().optional(),
    toTableName: z.string().optional(),
    toColumnId: z.string().optional(),
    toColumnName: z.string().optional(),
    cardinality: z.enum(["one-to-many", "one-to-one"]).optional(),
    identifying: z.boolean().optional(),
    onDelete: z.enum(["no action", "restrict", "cascade", "set null", "set default"]).optional(),
    onUpdate: z.enum(["no action", "restrict", "cascade", "set null", "set default"]).optional(),
  }),
  z.object({
    type: z.literal("remove_relation"),
    relationId: z.string().optional(),
    relationName: z.string().optional(),
  }),
]);

const proposalSchema = z.object({
  message: z.string().min(1),
  changes: z.array(changeSchema),
  warnings: z.array(z.string()).optional(),
});

const contextPlanSchema = z.object({
  intent: z.enum(["answer", "propose_changes"]),
  contextLevel: z.enum(["manifest", "table_details", "all_tables_columns", "full_compact_model"]),
  tablesNeeded: z.array(z.string()).default([]),
  reason: z.string().optional(),
}) satisfies z.ZodType<AiContextPlan>;

const requestSchema = z.object({
  prompt: z.string().min(1),
  project: z.custom<VisualProject>(),
  selectedTableId: z.string().optional(),
  locale: z.enum(locales).optional(),
  chatSummary: z.string().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .optional(),
});

function responseLanguage(locale: Locale) {
  if (locale === "es") return "Spanish";
  if (locale === "ca") return "Catalan";
  return "English";
}

function incompleteProposalMessage(locale: Locale) {
  if (locale === "es") return "La AI devolvió una propuesta incompleta, así que no he preparado cambios aplicables.";
  if (locale === "ca") return "L'AI ha retornat una proposta incompleta, així que no he preparat canvis aplicables.";
  return "The AI returned an incomplete proposal, so I did not prepare applicable changes.";
}

function incompleteProposalWarning(locale: Locale) {
  if (locale === "es") return "Vuelve a pedir la operación para que la propuesta incluya todas las tablas, columnas y relaciones necesarias.";
  if (locale === "ca") return "Torna a demanar l'operació perquè la proposta inclogui totes les taules, columnes i relacions necessàries.";
  return "Ask again so the proposal includes every required table, column, and relationship.";
}

const outputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["message", "changes"],
  properties: {
    message: {
      type: "string",
      description: "Short explanation for the user in the requested UI language.",
    },
    warnings: {
      type: "array",
      items: { type: "string" },
      description: "Warnings for destructive, ambiguous, or risky changes.",
    },
    changes: {
      type: "array",
      description: "Structured changes to apply only after the user accepts them.",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["type"],
        properties: {
          type: {
            type: "string",
            description: "Executable model operation type. Do not use message, note, explanation, or any conversational type here.",
            enum: [
              "add_table",
              "add_column",
              "update_column",
              "remove_column",
              "remove_table",
              "add_relation",
              "remove_relation",
            ],
          },
        },
      },
    },
  },
};

const contextPlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "contextLevel", "tablesNeeded"],
  properties: {
    intent: {
      type: "string",
      enum: ["answer", "propose_changes"],
      description: "Whether the user asks for an answer/review only or for executable model changes.",
    },
    contextLevel: {
      type: "string",
      enum: ["manifest", "table_details", "all_tables_columns", "full_compact_model"],
      description: "The smallest context package needed for a reliable answer.",
    },
    tablesNeeded: {
      type: "array",
      items: { type: "string" },
      description: "Specific table ids or schema.table names required when contextLevel is table_details.",
    },
    reason: {
      type: "string",
      description: "Short internal reason for the context choice.",
    },
  },
};

function isAiEnabled() {
  return process.env.NEXT_PUBLIC_DBOPENSTUDIO_AI_ENABLED === "true";
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

function stringifyParseIssue(error: unknown) {
  const issues = error instanceof z.ZodError ? error.issues : [];
  const firstIssue = issues[0];
  if (!firstIssue) return "The AI response could not be converted into model changes.";
  const path = firstIssue.path.length ? firstIssue.path.join(".") : "proposal";
  return `Invalid AI proposal at ${path}: ${firstIssue.message}`;
}

async function requestOpenAiJson({
  model,
  instructions,
  input,
  schemaName,
  schema,
}: {
  model: string;
  instructions: string;
  input: unknown;
  schemaName: string;
  schema: Record<string, unknown>;
}) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      instructions,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(input),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          strict: false,
          schema,
        },
      },
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    const message =
      typeof payload?.error?.message === "string" ? payload.error.message : "OpenAI request failed.";
    throw new Error(message);
  }

  const text = extractResponseText(payload);
  if (!text) {
    throw new Error("OpenAI did not return JSON.");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("OpenAI returned invalid JSON. Please try again.");
  }
}

export async function POST(request: Request) {
  if (!isAiEnabled()) {
    return NextResponse.json({ error: "AI is disabled. Set NEXT_PUBLIC_DBOPENSTUDIO_AI_ENABLED=true." }, { status: 403 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured." }, { status: 500 });
  }

  try {
    if (isSupabaseConfigured()) {
      const user = await userFromRequest(request);
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const input = requestSchema.parse(await request.json());
    const locale = normalizeLocale(input.locale);
    const project = {
      ...input.project,
      aiContext: normalizeProjectAiContext(input.project.aiContext),
    };
    const model = process.env.OPENAI_MODEL || "gpt-5-mini";
    const plannerModel = process.env.OPENAI_PLANNER_MODEL || model;
    const plannerPayload = await requestOpenAiJson({
      model: plannerModel,
      schemaName: "dbopenstudio_ai_context_plan",
      schema: contextPlanJsonSchema,
      instructions: [
        "You are the DBOpenStudio context planner.",
        "Do not answer the user's request and do not propose model changes.",
        "Choose the smallest context package needed for the final AI assistant to answer reliably.",
        "Use manifest for simple explanations or questions that do not need detailed table definitions.",
        "Use table_details when specific tables are enough; include every required table id or schema.table in tablesNeeded.",
        "Use all_tables_columns when the user asks to add, update, or inspect a column across every table.",
        "Use full_compact_model for global model reviews, broad CRM architecture questions, relationship design across unknown entities, or when serious cross-entity reasoning is needed.",
        "Use full_compact_model when the user asks to create an entity and connect it to several existing tables, add pointers/FKs across entities, or modify tables that must be inferred from domain context.",
        "If the user asks to modify/create/remove/normalize/apply anything, intent must be propose_changes. Otherwise intent is answer.",
        "If uncertain between a focused and global package, choose full_compact_model.",
        "Return only JSON with intent, contextLevel, tablesNeeded, and optional reason.",
      ].join("\n"),
      input: {
        prompt: input.prompt,
        selectedTableId: input.selectedTableId,
        projectAiContext: project.aiContext,
        compactedChatContext: input.chatSummary,
        recentMessages: input.messages?.slice(-4) ?? [],
        modelManifest: buildAiPlannerContext(project, input.selectedTableId),
      },
    });
    const parsedPlan = contextPlanSchema.safeParse(plannerPayload);
    if (!parsedPlan.success) {
      return NextResponse.json({ error: stringifyParseIssue(parsedPlan.error) }, { status: 502 });
    }

    const contextPlan = parsedPlan.data;
    const modelContext = buildAiModelContext(project, contextPlan, input.selectedTableId);
    const finalPayload = await requestOpenAiJson({
      model,
      schemaName: "dbopenstudio_ai_proposal",
      schema: outputJsonSchema,
      instructions: [
          "You are the DBOpenStudio AI assistant, a visual Postgres/Supabase data model designer.",
          "Act as a senior software and data architect: prioritize consistency, pragmatic normalization, referential integrity, clear naming, performance, maintainability, and safe migrations.",
          "Think like an expert software engineer before proposing changes. Avoid shallow models, redundant relationships, and ambiguous columns.",
          "Your job is to propose structured changes to the visual model, never to execute SQL or modify real databases.",
          `Respond in ${responseLanguage(locale)}.`,
          "If the user asks for an opinion, explanation, review, critique, or guidance, answer in the top-level message and return an empty changes array.",
          "When returning an empty changes array, keep the message concise: at most 6 short bullets or 120 words, no long checklists, and no extended follow-up menu.",
          "For model reviews without applicable changes, prioritize only the top 3 to 5 observations and mention that you can propose changes only if the user asks.",
          "Only include changes when the user asks you to modify, create, remove, normalize, or apply something to the model.",
          "Use existing IDs when a change affects existing tables, columns, or relationships.",
          "For new tables, new columns, or new relationships, do not invent IDs; the client will generate them.",
          "The message must match the executable changes exactly. If you say you will create a table, include an add_table change for it. If you say you will add an FK, include an add_relation change for it.",
          "Treat the changes array as an atomic proposal: every required table, column, and relation must be present and valid together. Do not return partial proposals.",
          "When the current model already contains orphan or FK-like columns that match the requested design, repair the model by reusing those columns and adding the missing table or relationship. Do not create duplicate *_id columns.",
          "Prefer non-destructive repairs: add missing tables, add missing relationships, and align source column type/nullability through add_relation. Do not remove or rename existing columns unless the user explicitly asks.",
          "When an add_relation points to a table that does not already exist in modelContext, include an add_table change for that target table in the same proposal.",
          "When an add_relation uses a source column that does not already exist in modelContext, include fromColumnName so the client can create it, or include a matching add_column change.",
          "If the user requests a typical entity, propose reasonable Postgres columns.",
          "If you add an FK, use add_relation. If the source column does not exist, prefer fromColumnName so relation creation owns the FK column.",
          "Use these exact change object shapes:",
          "add_table: { type: 'add_table', schema: 'public', name: 'table_name', columns: [{ name: 'id', type: 'uuid', primaryKey: true, nullable: false }, ...], visible: true }.",
          "add_column: { type: 'add_column', tableName: 'schema.table', column: { name: 'column_name', type: 'uuid', nullable: true } }.",
          "update_column: { type: 'update_column', tableName: 'schema.table', columnName: 'column_name', patch: { type: 'text', nullable: false } }.",
          "add_relation: { type: 'add_relation', fromTableName: 'schema.source_table', fromColumnName: 'target_id', toTableName: 'schema.target_table', toColumnName: 'id', cardinality: 'one-to-many', onDelete: 'set null', onUpdate: 'no action' }.",
          "remove_table, remove_column, and remove_relation require tableName/columnName/relationName or existing IDs.",
          "Do not use aliases such as create_table, fields, sourceTable, targetTable, source, target, references, foreignKeys, or relationships.",
          "For add_relation cardinality, use exactly one-to-many or one-to-one.",
          "For add_relation onDelete/onUpdate, use exactly no action, restrict, cascade, set null, or set default.",
          "Mark destructive changes in warnings and use remove_* only when the user clearly asks for them.",
          "Do not put conversational messages inside changes. Use the top-level message field for text and warnings for non-applicable notes.",
          "Every item in changes must be an executable model operation with one of the allowed type values.",
          "Use only the supplied modelContext. Do not assume hidden schema details that are not present.",
          "If the supplied modelContext is insufficient for any requested part, explain what is missing in message and return an empty changes array.",
          "Return only valid JSON with message, optional warnings, and changes.",
      ].join("\n"),
      input: {
        prompt: input.prompt,
        selectedTableId: input.selectedTableId,
        projectAiContext: project.aiContext,
        compactedChatContext: input.chatSummary,
        recentMessages: input.messages?.slice(-8) ?? [],
        contextPlan,
        modelContext,
      },
    });

    const normalizedProposal = normalizeAiProposalPayload(finalPayload);
    if (normalizedProposal.warnings?.some((warning) => warning.startsWith("Ignored incomplete AI change"))) {
      normalizedProposal.message = incompleteProposalMessage(locale);
      normalizedProposal.warnings = [incompleteProposalWarning(locale)];
    }
    const parsedProposal = proposalSchema.safeParse(normalizedProposal);
    if (!parsedProposal.success) {
      return NextResponse.json({ error: stringifyParseIssue(parsedProposal.error) }, { status: 502 });
    }

    const proposal = parsedProposal.data satisfies AiProposal;
    return NextResponse.json({ proposal });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not generate an AI proposal." },
      { status: 400 },
    );
  }
}
