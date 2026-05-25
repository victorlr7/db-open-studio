"use client";

/* eslint-disable react-hooks/set-state-in-effect */
import {
  Background,
  BaseEdge,
  Connection,
  Controls,
  Edge,
  EdgeLabelRenderer,
  EdgeProps,
  Handle,
  MiniMap,
  Node,
  NodeChange,
  NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getSmoothStepPath,
  useUpdateNodeInternals,
  useReactFlow,
} from "@xyflow/react";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleUserRound,
  Copy,
  CopyPlus,
  Database,
  Download,
  EyeOff,
  FileCode2,
  FolderPlus,
  GripVertical,
  Hand,
  Info,
  KeyRound,
  Link2,
  LogOut,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Save,
  Search,
  SendHorizontal,
  Sparkles,
  Table2,
  Trash2,
  Redo2,
  Undo2,
  Upload,
  UserPlus,
  X,
} from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import Image from "next/image";
import { CSSProperties, DragEvent, ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createCanvasView,
  createColumn,
  createTable,
  DEFAULT_TABLE_NODE_HEIGHT,
  DEFAULT_TABLE_NODE_WIDTH,
  emptyCanvas,
  normalizeProjectViews,
  stripCanvasViewMetadata,
  SUPABASE_URL,
} from "@/lib/defaults";
import {
  applyAiChanges,
  isDestructiveAiChange,
  type AiModelChange,
  type AiProposal,
} from "@/lib/ai-changes";
import { PROJECT_AI_CONTEXT_MAX_LENGTH, normalizeProjectAiContext } from "@/lib/ai-context";
import { createTranslator, normalizeLocale, type Locale, type TranslationKey, type Translator } from "@/lib/i18n";
import { exportProject, parseProjectExport } from "@/lib/project-export";
import { getBrowserSupabase } from "@/lib/supabase-client";
import type {
  AppUser,
  DbColumn,
  DbIndex,
  DbRelation,
  DbTable,
  GeneratedMigration,
  SchemaModel,
  VisualProject,
  WorkspaceStore,
} from "@/lib/types";

const columnTypes = [
  "uuid",
  "text",
  "varchar",
  "integer",
  "bigint",
  "numeric",
  "boolean",
  "date",
  "timestamp",
  "timestamptz",
  "jsonb",
];

const AI_CHAT_PAGE_SIZE = 5;
const MIGRATION_PAGE_SIZE = 10;
const MIGRATION_PANEL_MIN_HEIGHT = 260;
const AI_PANEL_MIN_WIDTH = 380;
const AI_PANEL_MAX_WIDTH = 760;
const PROJECT_HISTORY_LIMIT = 10;
const AI_CHATS_STORAGE_KEY = "dbopenstudio:ai-chats";
const AI_ACTIVE_CHATS_STORAGE_KEY = "dbopenstudio:ai-active-chats";
const IMPORT_SECRET_KEY_STORAGE_KEY = "dbopenstudio:import-secret-key";
const IMPORT_SECRET_STORAGE_PREFIX = "dbopenstudio:import-settings:";
const BRAND_LOGO_SRC = "/brand/db-open-studio-logo-transparent.png";
const BRAND_ICON_SRC = "/favicon.png";

const AI_ENABLED = process.env.NEXT_PUBLIC_DBOPENSTUDIO_AI_ENABLED === "true";

const edgeHandleSides = ["top", "right", "bottom", "left"] as const;
const edgeHandleFractions = [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6];
type EdgeHandleSide = (typeof edgeHandleSides)[number];

type TableNodeData = {
  table: DbTable;
  size: { width: number; height: number };
  collapsed: boolean;
  highlightedColumnIds: string[];
  fkColumnIds: string[];
  relationModeActive: boolean;
  relationSourceTableId?: string;
  selectedTableId?: string;
  t: Translator;
  onSelect: (tableId: string) => void;
  onResize: (tableId: string, size: { width: number; height: number }) => void;
  onResizeStart: () => void;
  onResizeEnd: () => void;
  onReorderColumn: (tableId: string, columnId: string, targetColumnId: string) => void;
  onRelationPick: (tableId: string) => void;
  onToggleCollapse: (tableId: string) => void;
};

function shortType(type: string) {
  return type.length > 15 ? `${type.slice(0, 14)}...` : type;
}

type DefaultValuePreset = {
  label: string;
  value: string;
};

function defaultValuePresetsForType(type: string): DefaultValuePreset[] {
  const normalized = type.toLowerCase();
  if (normalized.includes("timestamp") || normalized.includes("timestamptz")) {
    return [
      { label: "now()", value: "now()" },
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
    ];
  }
  if (normalized === "date" || normalized.includes(" date")) {
    return [{ label: "CURRENT_DATE", value: "CURRENT_DATE" }];
  }
  if (normalized === "time" || normalized.includes(" time")) {
    return [{ label: "CURRENT_TIME", value: "CURRENT_TIME" }];
  }
  if (normalized.includes("uuid")) {
    return [{ label: "gen_random_uuid()", value: "gen_random_uuid()" }];
  }
  if (normalized.includes("bool")) {
    return [
      { label: "true", value: "true" },
      { label: "false", value: "false" },
    ];
  }
  if (
    normalized.includes("int") ||
    normalized.includes("numeric") ||
    normalized.includes("decimal") ||
    normalized.includes("real") ||
    normalized.includes("double")
  ) {
    return [
      { label: "0", value: "0" },
      { label: "1", value: "1" },
    ];
  }
  if (normalized.includes("jsonb")) {
    return [
      { label: "{}::jsonb", value: "'{}'::jsonb" },
      { label: "[]::jsonb", value: "'[]'::jsonb" },
    ];
  }
  if (normalized.includes("json")) {
    return [
      { label: "{}", value: "'{}'" },
      { label: "[]", value: "'[]'" },
    ];
  }
  if (normalized.includes("text") || normalized.includes("char") || normalized.includes("citext")) {
    return [{ label: "''", value: "''" }];
  }
  return [];
}

const referentialActionOptions: NonNullable<DbRelation["onDelete"]>[] = [
  "no action",
  "restrict",
  "cascade",
  "set null",
  "set default",
];

function nowLocalIso() {
  return new Date().toISOString();
}

function normalizedProjectName(name: string) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function columnSearchOptions(table?: DbTable): ForeignKeyTargetOption[] {
  return (
    table?.columns.map((column) => ({
      value: column.id,
      label: column.name,
      searchText: `${table.schema}.${table.name}.${column.name} ${column.type}`.toLowerCase(),
      tableId: table.id,
      columnId: column.id,
    })) ?? []
  );
}

function tableSearchOptions(tables: DbTable[]): ForeignKeyTargetOption[] {
  return tables.map((table) => ({
    value: table.id,
    label: `${table.schema}.${table.name}`,
    searchText: `${table.schema}.${table.name}`.toLowerCase(),
    tableId: table.id,
    columnId: "",
  }));
}

function quoteSqlIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableSqlReference(table: DbTable) {
  return `${quoteSqlIdentifier(table.schema)}.${quoteSqlIdentifier(table.name)}`;
}

function indexColumnName(indexColumn: string, table: DbTable) {
  return table.columns.find((column) => column.id === indexColumn || column.name === indexColumn)?.name ?? indexColumn;
}

function indexColumnsLabel(index: DbIndex, table: DbTable, t: Translator) {
  const columns = index.columns.map((column) => indexColumnName(column, table)).filter(Boolean);
  return columns.length ? columns.join(", ") : t("index.expressionFallback");
}

function indexMethod(index: DbIndex) {
  const match = index.definition?.match(/\bUSING\s+([a-zA-Z0-9_]+)/i);
  return match?.[1]?.toLowerCase() ?? "btree";
}

function indexWhereClause(index: DbIndex) {
  const match = index.definition?.match(/\bWHERE\s+(.+)$/i);
  return match?.[1]?.replace(/;$/, "").trim();
}

function indexDefinitionSql(index: DbIndex, table: DbTable) {
  const definition = index.definition?.trim();
  if (definition) return definition.endsWith(";") ? definition : `${definition};`;
  const columns = index.columns.map((column) => quoteSqlIdentifier(indexColumnName(column, table))).join(", ");
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoteSqlIdentifier(index.name)} ON ${tableSqlReference(table)} (${columns || "/* columns */"});`;
}

function cloneProjectSnapshot(project: VisualProject) {
  return {
    ...project,
    connection: project.connection ? structuredClone(project.connection) : undefined,
    snapshot: project.snapshot ? structuredClone(project.snapshot) : undefined,
    canvas: structuredClone(project.canvas),
    views: project.views ? structuredClone(project.views) : undefined,
  };
}

function createAiChatSession(title = "New chat"): AiChatSession {
  const timestamp = nowLocalIso();
  return {
    id: crypto.randomUUID(),
    title,
    summary: "",
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function aiChatTitleFromPrompt(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) return "New chat";
  return normalized.length > 46 ? `${normalized.slice(0, 43)}...` : normalized;
}

function formatAiChatTimestamp(value: string, t: Translator) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const diffMs = Date.now() - time;
  const minutes = Math.max(0, Math.round(diffMs / 60000));
  if (minutes < 1) return t("common.now");
  if (minutes < 60) return t("common.minutesShort", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("common.hoursShort", { count: hours });
  const days = Math.round(hours / 24);
  return t("common.daysShort", { count: days });
}

function compactAiSession(session: AiChatSession, t: Translator): AiChatSession {
  if (session.messages.length <= 10) return session;
  const olderMessages = session.messages.slice(0, -8);
  const recentMessages = session.messages.slice(-8);
  const compacted = olderMessages
    .map((message) => `${message.role === "user" ? t("ai.userRole") : "AI"}: ${message.content}`)
    .join("\n")
    .slice(-5000);
  return {
    ...session,
    summary: [session.summary, compacted].filter(Boolean).join(`\n\n${t("ai.compactedSeparator")}\n`).slice(-8000),
    messages: recentMessages,
  };
}

type RelationEdgeData = {
  cardinality: "one-to-many" | "one-to-one";
  active: boolean;
  sourceLabel: string;
  targetLabel: string;
};

type RelationTool =
  | "non-identifying-one-to-one"
  | "non-identifying-one-to-many"
  | "identifying-one-to-one"
  | "identifying-one-to-many"
  | "many-to-many";

type RelationToolConfig = {
  id: RelationTool;
  label: string;
  titleKey: TranslationKey;
  cardinality: "one-to-many" | "one-to-one";
  identifying: boolean;
  manyToMany?: boolean;
};

type AiChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type AiChatSession = {
  id: string;
  title: string;
  summary: string;
  messages: AiChatMessage[];
  archived?: boolean;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type ImportFormState = {
  supabaseUrl: string;
  connectionString: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  schema: string;
  ssl: boolean;
  saveConnectionSettings: boolean;
};

type ImportPreviewTable = {
  key: string;
  schema: string;
  name: string;
  columns: number;
  status: "new" | "changed" | "unchanged";
  selected: boolean;
};

type ProjectNavigationAction =
  | { type: "selectProject"; projectId: string; closeBrowser?: boolean }
  | { type: "createProject" };

type ProjectHistoryEntry = {
  undo: VisualProject[];
  redo: VisualProject[];
};

type ProjectChangeOptions = {
  history?: boolean;
  historySnapshot?: VisualProject;
};

type ForeignKeyTargetOption = {
  value: string;
  label: string;
  searchText: string;
  tableId: string;
  columnId: string;
};

function ForeignKeyTargetSelect({
  value,
  selectedOption,
  options,
  open,
  search,
  t,
  emptyLabel,
  searchPlaceholder,
  noResultsLabel,
  allowEmpty = true,
  onOpen,
  onClose,
  onSearchChange,
  onChange,
}: {
  value: string;
  selectedOption?: ForeignKeyTargetOption;
  options: ForeignKeyTargetOption[];
  open: boolean;
  search: string;
  t: Translator;
  emptyLabel?: string;
  searchPlaceholder?: string;
  noResultsLabel?: string;
  allowEmpty?: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSearchChange: (value: string) => void;
  onChange: (value: string) => void;
}) {
  const normalizedSearch = search.trim().toLowerCase();
  const filteredOptions = normalizedSearch
    ? options.filter((option) => option.searchText.includes(normalizedSearch))
    : options;

  return (
    <div
      className={`fk-target-select ${open ? "fk-target-select-open" : ""}`}
      onBlur={(event) => {
        const relatedTarget = event.relatedTarget;
        if (!(relatedTarget instanceof globalThis.Node) || !event.currentTarget.contains(relatedTarget)) onClose();
      }}
    >
      <button
        aria-expanded={open}
        className={`select fk-target-trigger ${open ? "fk-target-trigger-open" : ""}`}
        onClick={() => {
          if (open) {
            onClose();
            return;
          }
          onOpen();
        }}
        type="button"
      >
        <span>{selectedOption?.label ?? emptyLabel ?? t("relation.noFk")}</span>
        <ChevronDown size={18} />
      </button>
      {open ? (
        <div className="fk-target-menu">
          <div className="fk-target-search">
            <Search size={15} />
            <input
              autoFocus
              placeholder={searchPlaceholder ?? t("relation.searchFk")}
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") onClose();
              }}
            />
          </div>
          <div className="fk-target-options" role="listbox">
            {allowEmpty ? (
              <button
                className={`fk-target-option ${!value ? "fk-target-option-active" : ""}`}
                onClick={() => onChange("")}
                type="button"
              >
                {emptyLabel ?? t("relation.noFk")}
              </button>
            ) : null}
            {filteredOptions.map((option) => (
              <button
                className={`fk-target-option ${option.value === value ? "fk-target-option-active" : ""}`}
                key={option.value}
                onClick={() => onChange(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
            {!filteredOptions.length ? <div className="fk-target-empty">{noResultsLabel ?? t("relation.noFkResults")}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

type EncryptedPayload = {
  iv: string;
  data: string;
};

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const relationToolConfigs: RelationToolConfig[] = [
  {
    id: "non-identifying-one-to-one",
    label: "1:1",
    titleKey: "relation.nonIdentifyingOneToOne",
    cardinality: "one-to-one",
    identifying: false,
  },
  {
    id: "non-identifying-one-to-many",
    label: "1:N",
    titleKey: "relation.nonIdentifyingOneToMany",
    cardinality: "one-to-many",
    identifying: false,
  },
  {
    id: "identifying-one-to-one",
    label: "1:1",
    titleKey: "relation.identifyingOneToOne",
    cardinality: "one-to-one",
    identifying: true,
  },
  {
    id: "identifying-one-to-many",
    label: "1:N",
    titleKey: "relation.identifyingOneToMany",
    cardinality: "one-to-many",
    identifying: true,
  },
  {
    id: "many-to-many",
    label: "N:M",
    titleKey: "relation.manyToMany",
    cardinality: "one-to-many",
    identifying: true,
    manyToMany: true,
  },
];

function relationToolConfig(tool: RelationTool) {
  return relationToolConfigs.find((config) => config.id === tool) ?? relationToolConfigs[1];
}

function RelationToolIcon({ tool }: { tool: RelationTool }) {
  const config = relationToolConfig(tool);
  return (
    <span className={`relation-tool-icon relation-tool-icon-${tool}`} aria-hidden="true">
      <span>{config.manyToMany ? "N" : "1"}</span>
      <span className="relation-tool-line" />
      <span>{config.manyToMany ? "M" : config.cardinality === "one-to-one" ? "1" : "N"}</span>
    </span>
  );
}

const RelationEdge = memo(function RelationEdge(props: EdgeProps<Edge<RelationEdgeData>>) {
  const [edgePath] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  const activeClass = props.data?.active ? "dbos-fk-edge-active" : "";

  return (
    <>
      <BaseEdge className={`dbos-fk-edge-path ${activeClass}`} id={props.id} path={edgePath} />
      <EdgeLabelRenderer>
        <div
          className={`fk-end-label fk-end-label-source ${activeClass}`}
          style={{ transform: `translate(-50%, -50%) translate(${props.sourceX}px, ${props.sourceY}px)` }}
        >
          {props.data?.sourceLabel ?? "1"}
        </div>
        <div
          className={`fk-end-label fk-end-label-target ${activeClass}`}
          style={{ transform: `translate(-50%, -50%) translate(${props.targetX}px, ${props.targetY}px)` }}
        >
          {props.data?.targetLabel ?? "N"}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

const TableNode = memo(function TableNode(props: NodeProps) {
  const data = props.data as TableNodeData;
  const table = data.table;
  const t = data.t;
  const selected = data.selectedTableId === table.id;
  const minHeight = data.collapsed ? 48 : DEFAULT_TABLE_NODE_HEIGHT;
  const rawVisibleColumnCount = data.collapsed
    ? 0
    : Math.max(0, Math.min(table.columns.length, Math.floor((data.size.height - 58) / 32)));
  const visibleColumnCount =
    rawVisibleColumnCount < table.columns.length
      ? Math.max(0, Math.min(table.columns.length, Math.floor((data.size.height - 82) / 32)))
      : rawVisibleColumnCount;
  const visibleColumns = table.columns.slice(0, visibleColumnCount);
  const hiddenColumnCount = Math.max(0, table.columns.length - visibleColumnCount);
  const updateNodeInternals = useUpdateNodeInternals();
  const reactFlow = useReactFlow();
  const [resizing, setResizing] = useState(false);
  const [draggedColumnId, setDraggedColumnId] = useState<string>();
  const [columnDropTargetId, setColumnDropTargetId] = useState<string>();

  useEffect(() => {
    updateNodeInternals(table.id);
  }, [data.collapsed, data.size.height, data.size.width, table.id, table.columns.length, updateNodeInternals]);

  function startColumnDrag(event: React.MouseEvent<HTMLDivElement>, columnId: string) {
    if (event.button !== 0 || data.relationModeActive) return;
    const target = event.target as HTMLElement;
    if (target.closest(".column-handle")) return;

    event.preventDefault();
    event.stopPropagation();
    data.onSelect(table.id);
    setDraggedColumnId(columnId);
    setColumnDropTargetId(columnId);

    function onMouseMove(moveEvent: MouseEvent) {
      const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const columnElement = element?.closest<HTMLElement>(`.node-column[data-table-id="${table.id}"]`);
      if (columnElement?.dataset.columnId) {
        setColumnDropTargetId(columnElement.dataset.columnId);
      }
    }

    function onMouseUp() {
      setDraggedColumnId(undefined);
      setColumnDropTargetId(undefined);
      const element = document.elementFromPoint(lastClientX, lastClientY);
      const columnElement = element?.closest<HTMLElement>(`.node-column[data-table-id="${table.id}"]`);
      const targetColumnId = columnElement?.dataset.columnId;
      if (targetColumnId && targetColumnId !== columnId) {
        data.onReorderColumn(table.id, columnId, targetColumnId);
      }
      window.removeEventListener("mousemove", trackMouse);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }

    let lastClientX = event.clientX;
    let lastClientY = event.clientY;
    function trackMouse(moveEvent: MouseEvent) {
      lastClientX = moveEvent.clientX;
      lastClientY = moveEvent.clientY;
    }

    window.addEventListener("mousemove", trackMouse);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  const beginTableResize = useCallback((clientX: number, clientY: number, pointerId?: number, target?: HTMLElement) => {
    data.onSelect(table.id);
    data.onResizeStart();
    if (pointerId !== undefined) {
      target?.setPointerCapture?.(pointerId);
    }

    const startX = clientX;
    const startY = clientY;
    const startSize = data.size;
    const zoom = reactFlow.getViewport().zoom || 1;
    const resizeTarget = target?.ownerDocument ?? document;
    setResizing(true);

    function onResizeMove(moveEvent: MouseEvent | PointerEvent) {
      data.onResize(table.id, {
        width: Math.max(220, startSize.width + (moveEvent.clientX - startX) / zoom),
        height: Math.max(minHeight, startSize.height + (moveEvent.clientY - startY) / zoom),
      });
    }

    function onResizeEnd() {
      setResizing(false);
      data.onResizeEnd();
      if (pointerId !== undefined && target?.hasPointerCapture?.(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
      window.removeEventListener("mousemove", onResizeMove);
      window.removeEventListener("mouseup", onResizeEnd);
      window.removeEventListener("pointermove", onResizeMove);
      window.removeEventListener("pointerup", onResizeEnd);
      resizeTarget.removeEventListener("mousemove", onResizeMove, true);
      resizeTarget.removeEventListener("mouseup", onResizeEnd, true);
      resizeTarget.removeEventListener("pointermove", onResizeMove, true);
      resizeTarget.removeEventListener("pointerup", onResizeEnd, true);
    }

    resizeTarget.addEventListener("mousemove", onResizeMove, true);
    resizeTarget.addEventListener("mouseup", onResizeEnd, true);
    resizeTarget.addEventListener("pointermove", onResizeMove, true);
    resizeTarget.addEventListener("pointerup", onResizeEnd, true);
  }, [data, minHeight, reactFlow, table.id]);

  function startTableResize(event: React.MouseEvent<HTMLDivElement> | React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    beginTableResize(
      event.clientX,
      event.clientY,
      "pointerId" in event ? event.pointerId : undefined,
      event.currentTarget,
    );
  }

  return (
    <div
      className={`table-node ${selected ? "table-node-selected" : ""} ${data.collapsed ? "table-node-collapsed" : ""} ${resizing ? "table-node-resizing" : ""}`}
      onClick={() => {
        if (data.relationModeActive) {
          data.onRelationPick(table.id);
          return;
        }
        data.onSelect(table.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          if (data.relationModeActive) {
            data.onRelationPick(table.id);
            return;
          }
          data.onSelect(table.id);
        }
      }}
      role="button"
      style={{ height: data.size.height, width: data.size.width }}
      tabIndex={0}
      data-testid={`table-node-${table.id}`}
    >
      <div className="node-title">
        <button
          aria-label={data.collapsed ? t("canvas.showFields") : t("canvas.hideFields")}
          className="node-collapse-button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            data.onToggleCollapse(table.id);
          }}
          onMouseDown={(event) => event.stopPropagation()}
          title={data.collapsed ? t("canvas.showFields") : t("canvas.hideFields")}
          type="button"
        >
          {data.collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
        </button>
        <Table2 size={16} />
        <span>{table.schema}.{table.name}</span>
        {data.relationSourceTableId === table.id ? (
          <span className="fk-source-pill">{t("canvas.source")}</span>
        ) : null}
      </div>
      {!data.collapsed ? (
        <div className="node-columns">
          {visibleColumns.map((column) => (
            <div
              className={`node-column ${data.highlightedColumnIds.includes(column.id) ? "node-column-highlighted" : ""} ${draggedColumnId === column.id ? "node-column-dragging" : ""} ${columnDropTargetId === column.id && draggedColumnId !== column.id ? "node-column-drop-target" : ""}`}
              data-column-id={column.id}
              data-table-id={table.id}
              key={column.id}
              onMouseDown={(event) => startColumnDrag(event, column.id)}
            >
              <Handle
                className="column-handle"
                id={`target:${column.id}`}
                position={Position.Left}
                type="target"
              />
              <span className="column-name">
                {column.primaryKey ? (
                  <span className="column-marker column-marker-pk">
                    <KeyRound size={12} />
                  </span>
                ) : (
                  <span
                    className={`column-marker column-marker-dot ${column.nullable ? "column-marker-nullable" : "column-marker-required"} ${data.fkColumnIds.includes(column.id) ? "column-marker-fk" : ""}`}
                  />
                )}
                {column.name}
              </span>
              <span className="column-type">{shortType(column.type)}</span>
              <Handle
                className="column-handle"
                id={`source:${column.id}`}
                position={Position.Right}
                type="source"
              />
            </div>
          ))}
          {hiddenColumnCount ? (
            <div className="node-hidden-count">
              {t("canvas.fieldsHidden", { count: hiddenColumnCount })}
            </div>
          ) : null}
        </div>
      ) : null}
      {edgeHandleSides.map((side) =>
        edgeHandleFractions.map((fraction, index) => {
          const style =
            side === "top" || side === "bottom"
              ? { left: `${fraction * 100}%` }
              : { top: `${fraction * 100}%` };
          const position =
            side === "top"
              ? Position.Top
              : side === "right"
                ? Position.Right
                : side === "bottom"
                  ? Position.Bottom
                  : Position.Left;

          return (
            <div className={`table-edge-handle-wrap table-edge-handle-${side}`} key={`${side}-${index}`} style={style}>
              <Handle
                className="table-edge-handle table-edge-handle-target"
                id={`target-${side}-${index}`}
                position={position}
                type="target"
              />
              <Handle
                className="table-edge-handle table-edge-handle-source"
                id={`source-${side}-${index}`}
                position={position}
                type="source"
              />
            </div>
          );
        }),
      )}
      <div
        aria-label={t("canvas.resizeTable")}
        className="nodrag nopan table-resize-handle table-custom-resize"
        data-resize-id={table.id}
        onPointerDown={startTableResize}
        role="separator"
        title={t("canvas.resizeTable")}
      />
    </div>
  );
});

const nodeTypes = { tableNode: TableNode };
const edgeTypes = { relationEdge: RelationEdge };

function emptyWorkspace(): WorkspaceStore {
  return { users: [], projects: [], migrations: [] };
}

async function getImportSecretKey() {
  const storedKey = window.localStorage.getItem(IMPORT_SECRET_KEY_STORAGE_KEY);
  if (storedKey) {
    return window.crypto.subtle.importKey("raw", base64ToBytes(storedKey), "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  const rawKey = window.crypto.getRandomValues(new Uint8Array(32));
  window.localStorage.setItem(IMPORT_SECRET_KEY_STORAGE_KEY, bytesToBase64(rawKey));
  return window.crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptImportSettings(settings: ImportFormState): Promise<EncryptedPayload> {
  const key = await getImportSecretKey();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(settings));
  const encrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted)),
  };
}

async function decryptImportSettings(payload: EncryptedPayload): Promise<ImportFormState> {
  const key = await getImportSecretKey();
  const decrypted = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
    key,
    base64ToBytes(payload.data),
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as ImportFormState;
}

async function loadStoredImportSettings(projectId: string) {
  const raw = window.localStorage.getItem(`${IMPORT_SECRET_STORAGE_PREFIX}${projectId}`);
  if (!raw) return undefined;
  return decryptImportSettings(JSON.parse(raw) as EncryptedPayload);
}

async function saveStoredImportSettings(projectId: string, settings: ImportFormState) {
  const encrypted = await encryptImportSettings(settings);
  window.localStorage.setItem(`${IMPORT_SECRET_STORAGE_PREFIX}${projectId}`, JSON.stringify(encrypted));
}

function removeStoredImportSettings(projectId: string) {
  window.localStorage.removeItem(`${IMPORT_SECRET_STORAGE_PREFIX}${projectId}`);
}

function updateProjectInStore(
  store: WorkspaceStore,
  projectId: string,
  updater: (project: VisualProject) => VisualProject,
) {
  return {
    ...store,
    projects: store.projects.map((project) => (project.id === projectId ? updater(project) : project)),
  };
}

function projectWithActiveView(project: VisualProject, preferredViewId?: string) {
  const normalized = normalizeProjectViews(project);
  const activeView =
    normalized.views?.find((view) => view.id === preferredViewId) ??
    normalized.views?.find((view) => view.id === normalized.activeViewId) ??
    normalized.views?.find((view) => view.isPrimary) ??
    normalized.views?.[0];

  if (!activeView) return normalized;

  return {
    ...normalized,
    activeViewId: activeView.id,
    canvas: stripCanvasViewMetadata(activeView.canvas),
  };
}

function syncActiveViewCanvas(project: VisualProject, preferredViewId?: string) {
  const activeProject = projectWithActiveView(project, preferredViewId ?? project.activeViewId);
  const activeViewId = activeProject.activeViewId;
  const timestamp = new Date().toISOString();
  const views = (activeProject.views ?? []).map((view) =>
    view.id === activeViewId
      ? {
          ...view,
          canvas: stripCanvasViewMetadata(project.canvas),
          updatedAt: timestamp,
        }
      : view,
  );

  return {
    ...activeProject,
    canvas: stripCanvasViewMetadata(project.canvas),
    views,
    activeViewId,
  };
}

function findTable(model: SchemaModel, tableId?: string) {
  return model.tables.find((table) => table.id === tableId);
}

function relationLabelFromIndexes(
  relation: DbRelation,
  tablesById: Map<string, DbTable>,
  columnsByKey: Map<string, DbColumn>,
  t: Translator,
) {
  const fromTable = tablesById.get(relation.fromTableId);
  const toTable = tablesById.get(relation.toTableId);
  const fromColumn = columnsByKey.get(`${relation.fromTableId}:${relation.fromColumnId}`);
  const toColumn = columnsByKey.get(`${relation.toTableId}:${relation.toColumnId}`);
  const cardinality = relation.cardinality === "one-to-one" ? "1:1" : "1:N";
  const kind = relation.identifying ? t("relation.labelIdentifying") : t("relation.labelNonIdentifying");
  return `${cardinality} ${kind} ${fromTable?.name ?? "?"}.${fromColumn?.name ?? "?"} -> ${toTable?.name ?? "?"}.${toColumn?.name ?? "?"}`;
}

function describeAiChangeText(change: AiModelChange, project: VisualProject, t: Translator) {
  if (change.type === "add_table") {
    return t("ai.changeAddTable", { schema: change.schema ?? "public", name: change.name });
  }
  if (change.type === "add_column") {
    return t("ai.changeAddColumn", { column: change.column.name, table: change.tableName ?? change.tableId ?? t("ai.tableFallback") });
  }
  if (change.type === "update_column") {
    return t("ai.changeUpdateColumn", { column: change.columnName ?? change.columnId ?? t("ai.columnFallback"), table: change.tableName ?? change.tableId ?? t("ai.tableFallback") });
  }
  if (change.type === "remove_column") {
    return t("ai.changeRemoveColumn", { column: change.columnName ?? change.columnId ?? t("ai.columnFallback"), table: change.tableName ?? change.tableId ?? t("ai.tableFallback") });
  }
  if (change.type === "remove_table") {
    return t("ai.changeRemoveTable", { table: change.tableName ?? change.tableId ?? t("ai.tableFallback") });
  }
  if (change.type === "add_relation") {
    const fromTable = findTable(project.model, change.fromTableId);
    const toTable = findTable(project.model, change.toTableId);
    return t("ai.changeAddRelation", {
      fromTable: fromTable?.name ?? change.fromTableName ?? t("ai.sourceFallback"),
      fromColumn: change.fromColumnName ?? change.fromColumnId ?? t("ai.columnFallback"),
      toTable: toTable?.name ?? change.toTableName ?? t("ai.targetFallback"),
      toColumn: change.toColumnName ?? change.toColumnId ?? t("ai.columnFallback"),
    });
  }
  return t("ai.changeRemoveRelation", { relation: change.relationName ?? change.relationId ?? "" }).trim();
}

function safeColumnName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "related";
}

function uniqueColumnName(table: DbTable, baseName: string) {
  const existing = new Set(table.columns.map((column) => column.name));
  if (!existing.has(baseName)) return baseName;

  let index = 2;
  let nextName = `${baseName}_${index}`;
  while (existing.has(nextName)) {
    index += 1;
    nextName = `${baseName}_${index}`;
  }
  return nextName;
}

function desiredTableHeight(table: DbTable) {
  return Math.max(DEFAULT_TABLE_NODE_HEIGHT, 58 + table.columns.length * 32);
}

function ensureTableNodeHeight(project: VisualProject, tableId: string, table: DbTable) {
  return {
    ...project.canvas,
    nodes: project.canvas.nodes.map((node) =>
      node.id === tableId && !node.collapsed
        ? {
            ...node,
            height: Math.max(node.height ?? DEFAULT_TABLE_NODE_HEIGHT, desiredTableHeight(table)),
          }
        : node,
    ),
  };
}

function uniqueTableName(model: SchemaModel, baseName: string) {
  const existing = new Set(model.tables.map((table) => table.name));
  if (!existing.has(baseName)) return baseName;

  let index = 2;
  let nextName = `${baseName}_${index}`;
  while (existing.has(nextName)) {
    index += 1;
    nextName = `${baseName}_${index}`;
  }
  return nextName;
}

function primaryReferenceColumn(table: DbTable) {
  return table.columns.find((column) => column.primaryKey) ?? table.columns[0];
}

function foreignKeyColumnName(table: DbTable, targetColumn: DbColumn) {
  const tableName = safeColumnName(table.name);
  return targetColumn.name === "id" ? `${tableName}_id` : `${tableName}_${targetColumn.name}`;
}

function createForeignKeyBetweenTables(
  project: VisualProject,
  fromTableId: string,
  toTableId: string,
  tool: RelationTool,
) {
  if (fromTableId === toTableId) return project;

  const config = relationToolConfig(tool);
  if (config.manyToMany) {
    return createManyToManyRelation(project, fromTableId, toTableId);
  }

  const fromTable = findTable(project.model, fromTableId);
  const toTable = findTable(project.model, toTableId);
  if (!fromTable || !toTable) return project;

  const targetColumn = primaryReferenceColumn(toTable);
  if (!targetColumn) return project;

  const preferredFkName = foreignKeyColumnName(toTable, targetColumn);
  let sourceColumn =
    fromTable.columns.find((column) => column.name === preferredFkName) ??
    fromTable.columns.find((column) => column.name === `${safeColumnName(toTable.name)}_id`);
  let nextTables = project.model.tables;

  if (!sourceColumn) {
    sourceColumn = createColumn(uniqueColumnName(fromTable, preferredFkName), {
      type: targetColumn.type,
      nullable: !config.identifying,
      primaryKey: config.identifying,
      unique: config.cardinality === "one-to-one",
      defaultValue: undefined,
    });
    nextTables = project.model.tables.map((table) =>
      table.id === fromTable.id ? { ...table, columns: [...table.columns, sourceColumn as DbColumn] } : table,
    );
  } else {
    sourceColumn = {
      ...sourceColumn,
      type: targetColumn.type,
      nullable: config.identifying ? false : sourceColumn.nullable,
      primaryKey: config.identifying ? true : sourceColumn.primaryKey,
      unique: config.cardinality === "one-to-one" ? true : sourceColumn.unique,
    };
    nextTables = project.model.tables.map((table) =>
      table.id === fromTable.id
        ? {
            ...table,
            columns: table.columns.map((column) => (column.id === sourceColumn?.id ? sourceColumn as DbColumn : column)),
          }
        : table,
    );
  }

  const duplicate = project.model.relations.some(
    (relation) =>
      relation.fromTableId === fromTable.id &&
      relation.toTableId === toTable.id &&
      relation.fromColumnId === sourceColumn.id &&
      relation.toColumnId === targetColumn.id,
  );
  if (duplicate) {
    return {
      ...project,
      model: { ...project.model, tables: nextTables },
      canvas: ensureTableNodeHeight(
        project,
        fromTable.id,
        nextTables.find((table) => table.id === fromTable.id) ?? fromTable,
      ),
    };
  }

  const relation: DbRelation = {
    id: crypto.randomUUID(),
    name: `${fromTable.name}_${sourceColumn.name}_fkey`,
    cardinality: config.cardinality,
    identifying: config.identifying,
    fromTableId: fromTable.id,
    fromColumnId: sourceColumn.id,
    toTableId: toTable.id,
    toColumnId: targetColumn.id,
    onDelete: "no action",
    onUpdate: "no action",
  };

  return {
    ...project,
    model: {
      ...project.model,
      tables: nextTables,
      relations: [...project.model.relations, relation],
    },
    canvas: ensureTableNodeHeight(
      project,
      fromTable.id,
      nextTables.find((table) => table.id === fromTable.id) ?? fromTable,
    ),
  };
}

function createManyToManyRelation(project: VisualProject, firstTableId: string, secondTableId: string) {
  const firstTable = findTable(project.model, firstTableId);
  const secondTable = findTable(project.model, secondTableId);
  if (!firstTable || !secondTable) return project;

  const firstColumn = primaryReferenceColumn(firstTable);
  const secondColumn = primaryReferenceColumn(secondTable);
  if (!firstColumn || !secondColumn) return project;

  const joinName = uniqueTableName(
    project.model,
    `${safeColumnName(firstTable.name)}_${safeColumnName(secondTable.name)}`,
  );
  const firstFkName = uniqueColumnName(
    { ...firstTable, columns: [] },
    foreignKeyColumnName(firstTable, firstColumn),
  );
  const secondFkNameBase = foreignKeyColumnName(secondTable, secondColumn);
  const firstJoinColumn = createColumn(firstFkName, {
    type: firstColumn.type,
    nullable: false,
    primaryKey: true,
    unique: false,
    defaultValue: undefined,
  });
  const secondJoinColumn = createColumn(
    secondFkNameBase === firstFkName ? `${safeColumnName(secondTable.name)}_${secondColumn.name}` : secondFkNameBase,
    {
      type: secondColumn.type,
      nullable: false,
      primaryKey: true,
      unique: false,
      defaultValue: undefined,
    },
  );
  const { table: baseJoinTable, node: baseJoinNode } = createTable(joinName);
  const joinTable: DbTable = {
    ...baseJoinTable,
    columns: [firstJoinColumn, secondJoinColumn],
  };
  const firstNode = project.canvas.nodes.find((node) => node.id === firstTable.id);
  const secondNode = project.canvas.nodes.find((node) => node.id === secondTable.id);
  const joinNode = {
    ...baseJoinNode,
    id: joinTable.id,
    position:
      firstNode && secondNode
        ? {
            x: (firstNode.position.x + secondNode.position.x) / 2 + 40,
            y: (firstNode.position.y + secondNode.position.y) / 2 + 80,
          }
        : { x: 180 + project.canvas.nodes.length * 40, y: 180 + project.canvas.nodes.length * 40 },
    height: desiredTableHeight(joinTable),
  };
  const relationToFirst: DbRelation = {
    id: crypto.randomUUID(),
    name: `${joinTable.name}_${firstJoinColumn.name}_fkey`,
    cardinality: "one-to-many",
    identifying: true,
    fromTableId: joinTable.id,
    fromColumnId: firstJoinColumn.id,
    toTableId: firstTable.id,
    toColumnId: firstColumn.id,
    onDelete: "cascade",
    onUpdate: "no action",
  };
  const relationToSecond: DbRelation = {
    id: crypto.randomUUID(),
    name: `${joinTable.name}_${secondJoinColumn.name}_fkey`,
    cardinality: "one-to-many",
    identifying: true,
    fromTableId: joinTable.id,
    fromColumnId: secondJoinColumn.id,
    toTableId: secondTable.id,
    toColumnId: secondColumn.id,
    onDelete: "cascade",
    onUpdate: "no action",
  };

  return {
    ...project,
    model: {
      ...project.model,
      tables: [...project.model.tables, joinTable],
      relations: [...project.model.relations, relationToFirst, relationToSecond],
    },
    canvas: {
      ...project.canvas,
      nodes: [...project.canvas.nodes, joinNode],
    },
  };
}

function oppositeSide(side: EdgeHandleSide): EdgeHandleSide {
  if (side === "top") return "bottom";
  if (side === "bottom") return "top";
  if (side === "left") return "right";
  return "left";
}

type EdgeHandleCandidate = {
  side: EdgeHandleSide;
  index: number;
  x: number;
  y: number;
  score: number;
};

function handleId(type: "source" | "target", side: EdgeHandleSide, index: number) {
  return `${type}-${side}-${index}`;
}

function nodeSize(node: VisualProject["canvas"]["nodes"][number]) {
  return {
    width: node.width ?? DEFAULT_TABLE_NODE_WIDTH,
    height: node.collapsed ? 48 : (node.height ?? DEFAULT_TABLE_NODE_HEIGHT),
  };
}

function nodeCenter(node: VisualProject["canvas"]["nodes"][number]) {
  const size = nodeSize(node);
  return {
    x: node.position.x + size.width / 2,
    y: node.position.y + size.height / 2,
  };
}

function handlePoint(node: VisualProject["canvas"]["nodes"][number], side: EdgeHandleSide, index: number) {
  const size = nodeSize(node);
  const fraction = edgeHandleFractions[index] ?? 0.5;
  if (side === "top") return { x: node.position.x + size.width * fraction, y: node.position.y };
  if (side === "bottom") return { x: node.position.x + size.width * fraction, y: node.position.y + size.height };
  if (side === "left") return { x: node.position.x, y: node.position.y + size.height * fraction };
  return { x: node.position.x + size.width, y: node.position.y + size.height * fraction };
}

function preferredSide(fromNode: VisualProject["canvas"]["nodes"][number], toNode: VisualProject["canvas"]["nodes"][number]) {
  const fromCenter = nodeCenter(fromNode);
  const toCenter = nodeCenter(toNode);
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  return Math.abs(dx) >= Math.abs(dy)
    ? dx >= 0
      ? "right"
      : "left"
    : dy >= 0
      ? "bottom"
      : "top";
}

function rankedHandleCandidates(
  node: VisualProject["canvas"]["nodes"][number],
  targetNode: VisualProject["canvas"]["nodes"][number],
  preferred: EdgeHandleSide,
) {
  const targetCenter = nodeCenter(targetNode);
  return edgeHandleSides
    .flatMap((side) =>
      edgeHandleFractions.map((_, index) => {
        const point = handlePoint(node, side, index);
        const distance = Math.hypot(point.x - targetCenter.x, point.y - targetCenter.y);
        const sidePenalty = side === preferred ? 0 : side === oppositeSide(preferred) ? 900 : 450;
        return { side, index, x: point.x, y: point.y, score: distance + sidePenalty };
      }),
    )
    .sort((a, b) => a.score - b.score);
}

function pickAvailableHandle(
  tableId: string,
  candidates: EdgeHandleCandidate[],
  occupied: Set<string>,
  type: "source" | "target",
) {
  const available = candidates.find((candidate) => !occupied.has(`${tableId}:${candidate.side}:${candidate.index}`));
  const selected = available ?? candidates[0];
  if (!selected) return undefined;
  occupied.add(`${tableId}:${selected.side}:${selected.index}`);
  return {
    handle: handleId(type, selected.side, selected.index),
    side: selected.side,
    point: { x: selected.x, y: selected.y },
  };
}

function relationEndpointLabels(relation: DbRelation) {
  return {
    source: relation.cardinality === "one-to-one" ? "1" : "N",
    target: "1",
  };
}

function relationUsesTable(relation: DbRelation, tableId?: string) {
  return Boolean(tableId && (relation.fromTableId === tableId || relation.toTableId === tableId));
}

function buildRelationEdges(
  canvasNodes: VisualProject["canvas"]["nodes"],
  activeRelationIds: Set<string>,
  candidateRelations: DbRelation[],
  stableHandles?: Map<string, { sourceHandle?: string; targetHandle?: string }>,
): Edge<RelationEdgeData>[] {
  const visibleTableIds = new Set(canvasNodes.map((node) => node.id));
  const nodesById = new Map(canvasNodes.map((node) => [node.id, node]));
  const occupiedHandles = new Set<string>();
  return candidateRelations
    .filter((relation) => visibleTableIds.has(relation.fromTableId) && visibleTableIds.has(relation.toTableId))
    .map((relation) => {
      const sourceNode = nodesById.get(relation.fromTableId);
      const targetNode = nodesById.get(relation.toTableId);
      if (!sourceNode || !targetNode) return undefined;
      const sourcePreferred = preferredSide(sourceNode, targetNode);
      const targetPreferred = oppositeSide(sourcePreferred);
      const sourcePick = pickAvailableHandle(
        sourceNode.id,
        rankedHandleCandidates(sourceNode, targetNode, sourcePreferred),
        occupiedHandles,
        "source",
      );
      const targetPick = pickAvailableHandle(
        targetNode.id,
        rankedHandleCandidates(targetNode, sourceNode, targetPreferred),
        occupiedHandles,
        "target",
      );
      const labels = relationEndpointLabels(relation);
      const stable = stableHandles?.get(relation.id);

      const edge: Edge<RelationEdgeData> = {
        id: relation.id,
        source: relation.fromTableId,
        target: relation.toTableId,
        sourceHandle: stable?.sourceHandle ?? sourcePick?.handle,
        targetHandle: stable?.targetHandle ?? targetPick?.handle,
        type: "relationEdge",
        animated: false,
        className: `dbos-fk-edge ${activeRelationIds.has(relation.id) ? "dbos-fk-edge-active" : ""}`,
        data: {
          cardinality: relation.cardinality ?? "one-to-many",
          active: activeRelationIds.has(relation.id),
          sourceLabel: labels.source,
          targetLabel: labels.target,
        },
      };
      return edge;
    })
    .filter((edge): edge is Edge<RelationEdgeData> => Boolean(edge));
}

function WorkspaceCanvas({
  project,
  relationMode,
  relationSourceTableId,
  selectedTableId,
  t,
  onRelationPick,
  onSelectTable,
  onClearSelection,
  onProjectChangeStart,
  onProjectChangeEnd,
  onProjectChange,
}: {
  project: VisualProject;
  relationMode: boolean;
  relationSourceTableId?: string;
  selectedTableId?: string;
  t: Translator;
  onRelationPick: (tableId: string) => void;
  onSelectTable: (tableId: string) => void;
  onClearSelection: () => void;
  onProjectChangeStart: () => void;
  onProjectChangeEnd: () => void;
  onProjectChange: (project: VisualProject, options?: ProjectChangeOptions) => void;
}) {
  const reactFlow = useReactFlow();
  const [hoveredRelationId, setHoveredRelationId] = useState<string>();
  const [flowNodes, setFlowNodes] = useState<Node[]>([]);
  const flowNodesRef = useRef<Node[]>([]);
  const flowNodesDirtyRef = useRef(false);
  const canvasInteractionRef = useRef(false);

  const updateFlowNodes = useCallback((updater: (nodes: Node[]) => Node[], markDirty = true) => {
    setFlowNodes((current) => {
      const next = updater(current);
      flowNodesRef.current = next;
      if (markDirty && next !== current) {
        flowNodesDirtyRef.current = true;
      }
      return next;
    });
  }, []);

  const commitLocalFlowNodes = useCallback(() => {
    if (!flowNodesDirtyRef.current) return;
    const flowById = new Map(flowNodesRef.current.map((node) => [node.id, node]));
    const nextNodes = project.canvas.nodes.map((node) => {
      const flowNode = flowById.get(node.id);
      if (!flowNode) return node;
      return {
        ...node,
        position: flowNode.position,
        width: typeof flowNode.width === "number" ? flowNode.width : node.width,
        height: typeof flowNode.height === "number" ? flowNode.height : node.height,
      };
    });
    flowNodesDirtyRef.current = false;
    onProjectChange(
      {
        ...project,
        canvas: {
          ...project.canvas,
          nodes: nextNodes,
        },
      },
      { history: false },
    );
  }, [onProjectChange, project]);

  const beginCanvasInteraction = useCallback(() => {
    canvasInteractionRef.current = true;
    onProjectChangeStart();
  }, [onProjectChangeStart]);

  const endCanvasInteraction = useCallback(() => {
    commitLocalFlowNodes();
    canvasInteractionRef.current = false;
    onProjectChangeEnd();
  }, [commitLocalFlowNodes, onProjectChangeEnd]);

  const canvasNodeIdKey = useMemo(() => project.canvas.nodes.map((node) => node.id).join("\u0000"), [project.canvas.nodes]);
  const canvasNodesById = useMemo(() => new Map(project.canvas.nodes.map((node) => [node.id, node])), [project.canvas.nodes]);
  const visibleTableIds = useMemo(() => new Set(canvasNodeIdKey ? canvasNodeIdKey.split("\u0000") : []), [canvasNodeIdKey]);
  const tablesById = useMemo(() => new Map(project.model.tables.map((table) => [table.id, table])), [project.model.tables]);
  const relationIdsByTable = useMemo(() => {
    const byTable = new Map<string, string[]>();
    project.model.relations.forEach((relation) => {
      const fromRelations = byTable.get(relation.fromTableId) ?? [];
      fromRelations.push(relation.id);
      byTable.set(relation.fromTableId, fromRelations);
      const toRelations = byTable.get(relation.toTableId) ?? [];
      toRelations.push(relation.id);
      byTable.set(relation.toTableId, toRelations);
    });
    return byTable;
  }, [project.model.relations]);
  const activeRelationIds = useMemo(() => {
    const ids = new Set<string>();
    if (hoveredRelationId) ids.add(hoveredRelationId);
    if (selectedTableId) {
      relationIdsByTable.get(selectedTableId)?.forEach((relationId) => ids.add(relationId));
    }
    return ids;
  }, [hoveredRelationId, relationIdsByTable, selectedTableId]);
  const visibleTables = useMemo(
    () => project.canvas.nodes.map((node) => tablesById.get(node.id)).filter((table): table is DbTable => Boolean(table)),
    [project.canvas.nodes, tablesById],
  );
  const relationsByVisibleTable = useMemo(() => {
    const byTable = new Map<string, DbRelation[]>();
    project.model.relations.forEach((relation) => {
      const fromVisible = visibleTableIds.has(relation.fromTableId);
      const toVisible = visibleTableIds.has(relation.toTableId);
      if (!fromVisible && !toVisible) return;
      if (fromVisible) byTable.set(relation.fromTableId, [...(byTable.get(relation.fromTableId) ?? []), relation]);
      if (toVisible) byTable.set(relation.toTableId, [...(byTable.get(relation.toTableId) ?? []), relation]);
    });
    return byTable;
  }, [project.model.relations, visibleTableIds]);
  const hoveredRelation = useMemo(
    () => project.model.relations.find((relation) => relation.id === hoveredRelationId),
    [hoveredRelationId, project.model.relations],
  );

  const resizeTableNode = useCallback(
    (tableId: string, size: { width: number; height: number }) => {
      updateFlowNodes((currentNodes) => {
        let changed = false;
        const nextNodes = currentNodes.map((node) => {
          if (node.id !== tableId) return node;
          changed = true;
          return {
            ...node,
            width: size.width,
            height: size.height,
            style: {
              ...(node.style ?? {}),
              width: size.width,
              height: size.height,
            },
            data: {
              ...node.data,
              size,
            },
          };
        });
        return changed ? nextNodes : currentNodes;
      });
    },
    [updateFlowNodes],
  );

  const reorderColumn = useCallback(
    (tableId: string, columnId: string, targetColumnId: string) => {
      const table = tablesById.get(tableId);
      if (!table || columnId === targetColumnId) return;
      const fromIndex = table.columns.findIndex((column) => column.id === columnId);
      const toIndex = table.columns.findIndex((column) => column.id === targetColumnId);
      if (fromIndex === -1 || toIndex === -1) return;
      const nextColumns = [...table.columns];
      const [movedColumn] = nextColumns.splice(fromIndex, 1);
      nextColumns.splice(toIndex, 0, movedColumn);
      onProjectChange({
        ...project,
        model: {
          ...project.model,
          tables: project.model.tables.map((item) =>
            item.id === tableId ? { ...item, columns: nextColumns } : item,
          ),
        },
      });
    },
    [onProjectChange, project, tablesById],
  );

  const toggleTableCollapse = useCallback(
    (tableId: string) => {
      const table = tablesById.get(tableId);
      if (!table) return;
      onProjectChange({
        ...project,
        canvas: {
          ...project.canvas,
          nodes: project.canvas.nodes.map((node) => {
            if (node.id !== tableId) return node;
            const nextCollapsed = !node.collapsed;
            return {
              ...node,
              collapsed: nextCollapsed,
              height: nextCollapsed
                ? node.height
                : (node.height ?? Math.max(DEFAULT_TABLE_NODE_HEIGHT, 58 + table.columns.length * 32)),
            };
          }),
        },
      });
    },
    [onProjectChange, project, tablesById],
  );

  const computedNodes = useMemo<Node[]>(
    () =>
      visibleTables.map((table, index) => {
        const canvasNode = canvasNodesById.get(table.id);
        const tableRelations = relationsByVisibleTable.get(table.id) ?? [];
        const selectedRelations = tableRelations.filter(
          (relation) => activeRelationIds.has(relation.id) && relationUsesTable(relation, table.id),
        );
        const highlightedColumnIds =
          selectedRelations.length > 0
            ? selectedRelations.flatMap((relation) => [relation.fromColumnId, relation.toColumnId])
            : hoveredRelation && (hoveredRelation.fromTableId === table.id || hoveredRelation.toTableId === table.id)
              ? [hoveredRelation.fromColumnId, hoveredRelation.toColumnId]
              : [];
        const fkColumnIds = tableRelations
          .filter((relation) => relation.fromTableId === table.id)
          .map((relation) => relation.fromColumnId);
        const nodeWidth = canvasNode?.width ?? DEFAULT_TABLE_NODE_WIDTH;
        const nodeHeight =
          canvasNode?.collapsed
            ? 48
            : canvasNode?.height ?? Math.max(DEFAULT_TABLE_NODE_HEIGHT, 58 + table.columns.length * 32);
        return {
          id: table.id,
          type: "tableNode",
          position: canvasNode?.position ?? { x: 100 + index * 60, y: 100 + index * 50 },
          dragHandle: ".node-title",
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          width: nodeWidth,
          height: nodeHeight,
          style: {
            width: nodeWidth,
            height: nodeHeight,
          },
          data: {
            table,
            size: { width: nodeWidth, height: nodeHeight },
            collapsed: Boolean(canvasNode?.collapsed),
            highlightedColumnIds,
            fkColumnIds,
            relationModeActive: relationMode,
            relationSourceTableId,
            selectedTableId,
            t,
            onSelect: onSelectTable,
            onResize: resizeTableNode,
            onResizeStart: beginCanvasInteraction,
            onResizeEnd: endCanvasInteraction,
            onReorderColumn: reorderColumn,
            onRelationPick,
            onToggleCollapse: toggleTableCollapse,
          },
        };
      }),
    [
      activeRelationIds,
      canvasNodesById,
      beginCanvasInteraction,
      endCanvasInteraction,
      hoveredRelation,
      onRelationPick,
      onSelectTable,
      relationMode,
      relationSourceTableId,
      reorderColumn,
      relationsByVisibleTable,
      resizeTableNode,
      selectedTableId,
      t,
      toggleTableCollapse,
      visibleTables,
    ],
  );

  useEffect(() => {
    if (canvasInteractionRef.current) return;
    setFlowNodes((current) => {
      const currentById = new Map(current.map((node) => [node.id, node]));
      const next = computedNodes.map((node) => {
        const currentNode = currentById.get(node.id);
        if (!currentNode) return node;
        return {
          ...node,
          selected: currentNode.selected,
        };
      });
      flowNodesRef.current = next;
      flowNodesDirtyRef.current = false;
      return next;
    });
  }, [computedNodes, project.id, project.activeViewId]);
  const renderedFlowNodes = flowNodes.length ? flowNodes : computedNodes;

  const visibleRelationCandidates = useMemo(() => {
    const unique = new Map<string, DbRelation>();
    relationsByVisibleTable.forEach((relations) => {
      relations.forEach((relation) => unique.set(relation.id, relation));
    });
    return Array.from(unique.values());
  }, [relationsByVisibleTable]);

  const stableRelationHandles = useMemo(() => {
    const stableEdges = buildRelationEdges(project.canvas.nodes, new Set<string>(), visibleRelationCandidates);
    return new Map(
      stableEdges.map((edge) => [
        edge.id,
        {
          sourceHandle: edge.sourceHandle ?? undefined,
          targetHandle: edge.targetHandle ?? undefined,
        },
      ]),
    );
  }, [project.canvas.nodes, visibleRelationCandidates]);

  const edges = useMemo<Edge<RelationEdgeData>[]>(
    () => buildRelationEdges(project.canvas.nodes, activeRelationIds, visibleRelationCandidates, stableRelationHandles),
    [activeRelationIds, project.canvas.nodes, stableRelationHandles, visibleRelationCandidates],
  );
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const layoutChanged = changes.some((change) => change.type === "position" || change.type === "dimensions");
      updateFlowNodes((currentNodes) => applyNodeChanges(changes, currentNodes), layoutChanged);
    },
    [updateFlowNodes],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) {
        return;
      }

      const fromColumnId = connection.sourceHandle.replace("source:", "");
      const toColumnId = connection.targetHandle.replace("target:", "");
      const fromTable = findTable(project.model, connection.source);
      const toTable = findTable(project.model, connection.target);
      const fromColumn = fromTable?.columns.find((column) => column.id === fromColumnId);
      const toColumn = toTable?.columns.find((column) => column.id === toColumnId);
      if (!fromTable || !toTable || !fromColumn || !toColumn) return;

      const duplicate = project.model.relations.some(
        (relation) =>
          relation.fromTableId === fromTable.id &&
          relation.fromColumnId === fromColumn.id &&
          relation.toTableId === toTable.id &&
          relation.toColumnId === toColumn.id,
      );
      if (duplicate) return;

      const relation: DbRelation = {
        id: crypto.randomUUID(),
        name: `${fromTable.name}_${fromColumn.name}_fkey`,
        cardinality: "one-to-many",
        fromTableId: fromTable.id,
        fromColumnId: fromColumn.id,
        toTableId: toTable.id,
        toColumnId: toColumn.id,
        onDelete: "no action",
        onUpdate: "no action",
      };

      onProjectChange({
        ...project,
        model: {
          ...project.model,
          relations: [...project.model.relations, relation],
        },
      });
    },
    [onProjectChange, project],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/dbopenstudio");
      const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      if (type.startsWith("table:")) {
        const tableId = type.replace("table:", "");
        const table = project.model.tables.find((item) => item.id === tableId);
        if (!table) return;
        const existingNode = project.canvas.nodes.find((node) => node.id === tableId);
        const nextNode = {
          id: tableId,
          position,
          width: existingNode?.width ?? DEFAULT_TABLE_NODE_WIDTH,
          height: existingNode?.height ?? Math.max(DEFAULT_TABLE_NODE_HEIGHT, 58 + table.columns.length * 32),
          collapsed: existingNode?.collapsed,
        };
        onProjectChange({
          ...project,
          canvas: {
            ...project.canvas,
            nodes: existingNode
              ? project.canvas.nodes.map((node) => (node.id === tableId ? nextNode : node))
              : [...project.canvas.nodes, nextNode],
          },
        });
        onSelectTable(tableId);
        return;
      }

      if (type !== "new-table") return;

      const baseName = `table_${project.model.tables.length + 1}`;
      const { table, node } = createTable(baseName, position.x, position.y);

      onProjectChange({
        ...project,
        model: {
          ...project.model,
          tables: [...project.model.tables, table],
        },
        canvas: {
          ...project.canvas,
          nodes: [...project.canvas.nodes, node],
        },
      });
      onSelectTable(table.id);
    },
    [onProjectChange, onSelectTable, project, reactFlow],
  );

  return (
    <div className={`flow-wrap ${relationMode ? "fk-mode" : ""}`}>
      {relationMode ? (
        <div className="fk-mode-banner">
          {relationSourceTableId ? t("canvas.fkTarget") : t("canvas.fkSource")}
        </div>
      ) : null}
      <ReactFlow
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        key={project.id}
        nodes={renderedFlowNodes}
        edges={edges}
        edgeTypes={edgeTypes}
        nodeTypes={nodeTypes}
        onConnect={onConnect}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
        onNodesChange={onNodesChange}
        nodesDraggable
        onNodeDragStart={(_, node) => {
          beginCanvasInteraction();
          onSelectTable(node.id);
        }}
        onNodeDragStop={endCanvasInteraction}
        onPaneClick={onClearSelection}
        onEdgesDelete={(deleted) => {
          const deletedIds = new Set(deleted.map((edge) => edge.id));
          onProjectChange({
            ...project,
            model: {
              ...project.model,
              relations: project.model.relations.filter((relation) => !deletedIds.has(relation.id)),
            },
          });
        }}
        onEdgeMouseEnter={(_, edge) => setHoveredRelationId(edge.id)}
        onEdgeMouseLeave={() => setHoveredRelationId(undefined)}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#c9d3df" gap={18} />
        <Controls position="bottom-left" />
        <MiniMap pannable position="bottom-right" zoomable />
      </ReactFlow>
    </div>
  );
}

function ProjectBrowser({
  projects,
  activeProjectId,
  activeUserId,
  onDeleteProject,
  onSelectProject,
  onShareProject,
  t,
}: {
  projects: VisualProject[];
  activeProjectId?: string;
  activeUserId?: string;
  onDeleteProject: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  onShareProject: (projectId: string) => void;
  t: Translator;
}) {
  return (
    <section className="project-browser">
      {projects.length ? (
        <div className="project-browser-grid">
          {projects.map((item) => {
            const isOwner = item.userId === activeUserId;
            return (
              <article
                className={`project-browser-card ${item.id === activeProjectId ? "project-browser-card-active" : ""}`}
                key={item.id}
              >
                <button className="project-browser-select" onClick={() => onSelectProject(item.id)} type="button">
                  <span className="project-browser-file">
                    <Database size={22} />
                  </span>
                  <span className="project-browser-main">
                    <strong>{item.name}</strong>
                    <span>{item.description || t("common.defaultProjectDescription")}</span>
                    <small>
                      {t("sidebar.tablesCount", { count: item.model.tables.length })} ·{" "}
                      {t("project.updatedAt", { date: new Date(item.updatedAt).toLocaleString() })}
                    </small>
                    {!isOwner ? <small>{t("project.sharedBy", { owner: item.ownerEmail ?? item.ownerName ?? t("common.userFallback") })}</small> : null}
                  </span>
                  {item.id === activeProjectId ? <span className="project-browser-active">{t("project.activeBadge")}</span> : <ChevronRight size={18} />}
                </button>
                <div className="project-browser-actions">
                  <button
                    className="icon-button"
                    disabled={!isOwner}
                    onClick={() => onShareProject(item.id)}
                    title={isOwner ? t("project.share") : t("project.shareOwnerOnly")}
                    type="button"
                  >
                    <UserPlus size={15} />
                  </button>
                  <button
                    className="danger-icon"
                    onClick={() => onDeleteProject(item.id)}
                    title={isOwner ? t("project.delete") : t("project.unlink")}
                    type="button"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="project-browser-empty">
          <div className="confirm-icon">
            <FolderPlus size={22} />
          </div>
          <h2>{t("project.emptyTitle")}</h2>
          <p>{t("project.emptyBody")}</p>
        </div>
      )}
    </section>
  );
}

function UserProfileView({
  canChangePassword,
  draft,
  message,
  saving,
  user,
  onDraftChange,
  onSave,
  onSignOut,
  t,
}: {
  canChangePassword: boolean;
  draft: { name: string; email: string; password: string; locale: Locale };
  message: string;
  saving: boolean;
  user?: AppUser;
  onDraftChange: (draft: { name: string; email: string; password: string; locale: Locale }) => void;
  onSave: () => void;
  onSignOut: () => void;
  t: Translator;
}) {
  return (
    <section className="user-profile-canvas">
      <div className="user-profile-panel">
        <div className="user-profile-head">
          <span className="user-profile-avatar">
            <CircleUserRound size={28} />
          </span>
          <div>
            <h2>{t("profile.title")}</h2>
            <p>{user?.email ?? user?.name ?? t("common.userFallback")}</p>
          </div>
        </div>
        <div className="user-profile-form">
          <label>
            {t("auth.name")}
            <input
              autoComplete="name"
              value={draft.name}
              onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
            />
          </label>
          <label>
            {t("auth.email")}
            <input
              autoComplete="email"
              type="email"
              value={draft.email}
              onChange={(event) => onDraftChange({ ...draft, email: event.target.value })}
            />
          </label>
          <label>
            {t("auth.password")}
            <input
              autoComplete="new-password"
              disabled={!canChangePassword}
              placeholder={canChangePassword ? t("profile.passwordPlaceholder") : t("profile.passwordUnavailable")}
              type="password"
              value={draft.password}
              onChange={(event) => onDraftChange({ ...draft, password: event.target.value })}
            />
          </label>
          <label>
            {t("sidebar.language")}
            <select
              className="select"
              value={draft.locale}
              onChange={(event) => onDraftChange({ ...draft, locale: normalizeLocale(event.target.value) })}
            >
              <option value="en">{t("sidebar.languageEnglish")}</option>
              <option value="es">{t("sidebar.languageSpanish")}</option>
              <option value="ca">{t("sidebar.languageCatalan")}</option>
            </select>
          </label>
        </div>
        {message ? <p className="user-profile-message">{message}</p> : null}
        <div className="user-profile-actions">
          <button className="button secondary" onClick={onSignOut} type="button">
            <LogOut size={16} />
            {t("sidebar.signOut")}
          </button>
          <button className="button primary" disabled={saving || !draft.name.trim()} onClick={onSave} type="button">
            {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            {t("profile.save")}
          </button>
        </div>
      </div>
    </section>
  );
}

function MigrationsBrowser({
  aiEnabled,
  describingMigrationId,
  migrationAuthor,
  migrations,
  page,
  onDescribe,
  onDownload,
  onPageChange,
  onShowInConsole,
  t,
}: {
  aiEnabled: boolean;
  describingMigrationId?: string;
  migrationAuthor: (migration: GeneratedMigration) => string;
  migrations: GeneratedMigration[];
  page: number;
  onDescribe: (migration: GeneratedMigration) => void;
  onDownload: (migration: GeneratedMigration) => void;
  onPageChange: (page: number) => void;
  onShowInConsole: (migration: GeneratedMigration) => void;
  t: Translator;
}) {
  const pageCount = Math.max(1, Math.ceil(migrations.length / MIGRATION_PAGE_SIZE));
  const normalizedPage = Math.min(page, pageCount - 1);
  const pagedMigrations = migrations.slice(
    normalizedPage * MIGRATION_PAGE_SIZE,
    normalizedPage * MIGRATION_PAGE_SIZE + MIGRATION_PAGE_SIZE,
  );

  return (
    <section className="migration-browser">
      {migrations.length ? (
        <>
          <div className="migration-table-wrap">
            <table className="migration-table">
              <thead>
                <tr>
                  <th>{t("migration.tableName")}</th>
                  <th>{t("migration.tableCreated")}</th>
                  <th>{t("migration.tableUser")}</th>
                  <th>{t("migration.tableChanges")}</th>
                  <th>{t("migration.tableWarnings")}</th>
                  <th>{t("migration.tableActions")}</th>
                </tr>
              </thead>
              <tbody>
                {pagedMigrations.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.name}</strong>
                      <small>{item.id}</small>
                    </td>
                    <td>{new Date(item.createdAt).toLocaleString()}</td>
                    <td>{migrationAuthor(item)}</td>
                    <td>{item.summary.items.length}</td>
                    <td>{item.warnings.length}</td>
                    <td>
                      <div className="migration-table-actions">
                        <button
                          className="button secondary migration-ai-button"
                          disabled={!aiEnabled || describingMigrationId === item.id}
                          onClick={() => onDescribe(item)}
                          title={aiEnabled ? t("migration.aiDescription") : t("migration.aiDisabled")}
                          type="button"
                        >
                          {describingMigrationId === item.id ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />}
                          <span>{t("migration.aiDescription")}</span>
                        </button>
                        <button className="icon-button" onClick={() => onDownload(item)} title={t("migration.download")} type="button">
                          <Download size={15} />
                        </button>
                        <button className="icon-button" onClick={() => onShowInConsole(item)} title={t("migration.showInConsole")} type="button">
                          <FileCode2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="migration-browser-pagination">
            <span>{t("migration.pageStatus", { page: normalizedPage + 1, pages: pageCount })}</span>
            <div className="row">
              <button className="button secondary" disabled={normalizedPage === 0} onClick={() => onPageChange(normalizedPage - 1)} type="button">
                {t("common.previous")}
              </button>
              <button className="button secondary" disabled={normalizedPage >= pageCount - 1} onClick={() => onPageChange(normalizedPage + 1)} type="button">
                {t("common.next")}
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="project-browser-empty">
          <div className="confirm-icon">
            <FileCode2 size={22} />
          </div>
          <h2>{t("migration.emptyTitle")}</h2>
          <p>{t("migration.emptyBody")}</p>
        </div>
      )}
    </section>
  );
}

const sqlKeywordSet = new Set([
  "ADD",
  "ALTER",
  "COLUMN",
  "CONSTRAINT",
  "CREATE",
  "DELETE",
  "DROP",
  "EXISTS",
  "FOREIGN",
  "IF",
  "KEY",
  "NOT",
  "NULL",
  "PRIMARY",
  "REFERENCES",
  "SCHEMA",
  "SET",
  "TABLE",
  "UNIQUE",
]);

const sqlTypeSet = new Set([
  "bigint",
  "boolean",
  "date",
  "integer",
  "jsonb",
  "name",
  "numeric",
  "text",
  "timestamp",
  "timestamptz",
  "uuid",
  "varchar",
]);

function sqlTokenClass(token: string, previousSignificantToken?: string, lineBeforeToken = "") {
  if (/^--/.test(token)) return "sql-comment";
  if (/^[(),.;]+$/.test(token)) return "sql-punctuation";
  const normalized = token.toUpperCase();
  if (sqlKeywordSet.has(normalized)) return "sql-keyword";
  if (sqlTypeSet.has(token.toLowerCase())) return "sql-type";
  if (/^".*"$/.test(token)) {
    if (previousSignificantToken === "CONSTRAINT") return "sql-constraint";
    if (previousSignificantToken === "REFERENCES") return "sql-table";
    if (/\bREFERENCES\b[\s\S]*\($/i.test(lineBeforeToken)) return "sql-reference";
    if (
      /\b(ALTER|CREATE)\s+TABLE\b/i.test(lineBeforeToken) &&
      !/\bADD\b|\bCOLUMN\b|\bCONSTRAINT\b/i.test(lineBeforeToken)
    ) {
      return "sql-table";
    }
    if (/\bREFERENCES\b/i.test(lineBeforeToken) && !/\bREFERENCES\b[\s\S]*\(/i.test(lineBeforeToken)) return "sql-table";
    if (previousSignificantToken === "TABLE" || previousSignificantToken === "SCHEMA") return "sql-table";
    return "sql-column";
  }
  return undefined;
}

function renderSql(sql: string) {
  return sql.split("\n").map((line, lineIndex) => {
    if (line.trimStart().startsWith("--")) {
      return (
        <span className="sql-line" key={`${lineIndex}-comment`}>
          <span className="sql-comment">{line}</span>
          {"\n"}
        </span>
      );
    }

    const tokens = line.match(/\s+|--.*$|"[^"]+"|[(),.;]|\b[\w]+\b|\S/g) ?? [];
    let previousSignificantToken: string | undefined;
    let consumedLine = "";
    return (
      <span className="sql-line" key={lineIndex}>
        {tokens.map((token, tokenIndex) => {
          const isWhitespace = /^\s+$/.test(token);
          const tokenClass = isWhitespace ? undefined : sqlTokenClass(token, previousSignificantToken, consumedLine);
          if (!isWhitespace && !/^[(),.;]+$/.test(token)) {
            previousSignificantToken = token.replaceAll('"', "").toUpperCase();
          }
          consumedLine += token;
          return tokenClass ? (
            <span className={tokenClass} key={`${lineIndex}-${tokenIndex}`}>
              {token}
            </span>
          ) : (
            <span key={`${lineIndex}-${tokenIndex}`}>{token}</span>
          );
        })}
        {"\n"}
      </span>
    );
  });
}

function renderInlineMarkdown(text: string, keyPrefix: string) {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .split(/(\n|`[^`]+`)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part === "\n") return <br key={`${keyPrefix}-${index}`} />;
      return part.startsWith("`") && part.endsWith("`") ? (
        <code key={`${keyPrefix}-${index}`}>{part.slice(1, -1)}</code>
      ) : (
        <span key={`${keyPrefix}-${index}`}>{part}</span>
      );
    });
}

function localizeMigrationMarkdown(markdown: string, locale: Locale) {
  if (locale !== "es" && locale !== "ca") return markdown;
  const headingMapByLocale: Record<"es" | "ca", Record<string, string>> = {
    es: {
      summary: "Resumen",
      "main changes": "Cambios principales",
      "affected tables": "Tablas afectadas",
      relationships: "Relaciones",
      "impact on existing data": "Impacto en datos existentes",
      "manual review": "Revisión manual",
      verdict: "Veredicto",
    },
    ca: {
      summary: "Resum",
      "main changes": "Canvis principals",
      "affected tables": "Taules afectades",
      relationships: "Relacions",
      "impact on existing data": "Impacte en dades existents",
      "manual review": "Revisió manual",
      verdict: "Veredicte",
    },
  };
  const headingMap = headingMapByLocale[locale];
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        const translated = headingMap[heading[2].trim().toLowerCase()];
        if (translated) return `${heading[1]} ${translated}`;
      }
      if (/^\|\s*Table\s*\|\s*Change\s*\|\s*Risk\s*\|?\s*$/i.test(line)) {
        return locale === "ca" ? "| Taula | Canvi | Risc |" : "| Tabla | Cambio | Riesgo |";
      }
      if (locale === "ca") {
        return line
          .replace(/\bLow\b/g, "Baix")
          .replace(/\bMedium\b/g, "Mitjà")
          .replace(/\bHigh\b/g, "Alt")
          .replace(/No relationships are created, removed, or modified\./gi, "No es creen, eliminen ni modifiquen relacions.")
          .replace(
            /This cannot be determined from the available SQL and project context\./gi,
            "No es pot determinar amb el SQL i el context del projecte disponibles.",
          )
          .replace(/\bSafe to apply\b/g, "Segur d'aplicar")
          .replace(/\bProbably safe, review\b/g, "Probablement segur, revisar")
          .replace(/\bRisky, review carefully\b/g, "Arriscat, revisar acuradament")
          .replace(/\bDestructive migration\b/g, "Migració destructiva");
      }
      return line
        .replace(/\bLow\b/g, "Bajo")
        .replace(/\bMedium\b/g, "Medio")
        .replace(/\bHigh\b/g, "Alto")
        .replace(/No relationships are created, removed, or modified\./gi, "No se crean, eliminan ni modifican relaciones.")
        .replace(
          /This cannot be determined from the available SQL and project context\./gi,
          "No se puede determinar con el SQL y el contexto del proyecto disponibles.",
        )
        .replace(/\bSafe to apply\b/g, "Seguro de aplicar")
        .replace(/\bProbably safe, review\b/g, "Probablemente seguro, revisar")
        .replace(/\bRisky, review carefully\b/g, "Riesgoso, revisar cuidadosamente")
        .replace(/\bDestructive migration\b/g, "Migración destructiva");
    })
    .join("\n");
}

function isMarkdownTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderMarkdown(markdown: string) {
  const lines = markdown.trim().split(/\r?\n/);
  const elements: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.trim().startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      elements.push(
        <pre className="markdown-code-block" key={`code-${index}`}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2], `heading-${index}`);
      if (level === 1) elements.push(<h1 key={`heading-${index}`}>{content}</h1>);
      if (level === 2) elements.push(<h2 key={`heading-${index}`}>{content}</h2>);
      if (level >= 3) elements.push(<h3 key={`heading-${index}`}>{content}</h3>);
      index += 1;
      continue;
    }

    if (line.trim().startsWith("|") && lines[index + 1] && isMarkdownTableSeparator(lines[index + 1])) {
      const headers = splitMarkdownTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(splitMarkdownTableRow(lines[index]));
        index += 1;
      }
      elements.push(
        <div className="markdown-table-wrap" key={`table-${index}`}>
          <table>
            <thead>
              <tr>
                {headers.map((header, headerIndex) => (
                  <th key={`table-${index}-head-${headerIndex}`}>{renderInlineMarkdown(header, `table-${index}-head-${headerIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`table-${index}-row-${rowIndex}`}>
                  {headers.map((_, cellIndex) => (
                    <td key={`table-${index}-row-${rowIndex}-${cellIndex}`}>
                      {renderInlineMarkdown(row[cellIndex] ?? "", `table-${index}-row-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*(?:[-*]|\d+\.)\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
        index += 1;
      }
      elements.push(
        <ul key={`list-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`list-${index}-${itemIndex}`}>{renderInlineMarkdown(item, `list-${index}-${itemIndex}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,3})\s+/.test(lines[index]) &&
      !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[index]) &&
      !lines[index].trim().startsWith("|") &&
      !lines[index].trim().startsWith("```")
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    elements.push(<p key={`paragraph-${index}`}>{renderInlineMarkdown(paragraph.join(" "), `paragraph-${index}`)}</p>);
  }

  return <div className="markdown-review">{elements}</div>;
}

function migrationReviewStats(migration: GeneratedMigration) {
  const affectedTables = new Set<string>();
  let relationshipChangesCount = 0;
  let destructiveSummaryCount = 0;

  migration.summary.items.forEach((item) => {
    if (item.type === "added_table" || item.type === "removed_table") affectedTables.add(`${item.table.schema}.${item.table.name}`);
    if (item.type === "added_column" || item.type === "removed_column" || item.type === "modified_column") {
      affectedTables.add(`${item.table.schema}.${item.table.name}`);
    }
    if (item.type === "added_relation" || item.type === "removed_relation") {
      relationshipChangesCount += 1;
      affectedTables.add(item.relation.fromTableId);
      affectedTables.add(item.relation.toTableId);
    }
    if (item.type === "removed_table" || item.type === "removed_column") destructiveSummaryCount += 1;
    if (item.type === "modified_column" && item.changes.some((change) => /type|not null|nullable/i.test(change))) {
      destructiveSummaryCount += 1;
    }
  });

  const destructiveSqlCount =
    migration.sql.match(/\bDROP\s+(TABLE|COLUMN)\b|\bDELETE\s+FROM\b|\bUPDATE\s+\S+\s+SET\b/gi)?.length ?? 0;
  const destructiveChangesCount = destructiveSummaryCount + destructiveSqlCount;
  const hasHighRiskSql = /\bALTER\s+TABLE[\s\S]*\bALTER\s+COLUMN[\s\S]*\bTYPE\b/i.test(migration.sql) || /\bSET\s+NOT\s+NULL\b/i.test(migration.sql);
  const hasMediumRiskSql = /\bFOREIGN\s+KEY\b|\bUNIQUE\b|\bON\s+(DELETE|UPDATE)\s+CASCADE\b|\bDEFAULT\b/i.test(migration.sql);
  const risk: "low" | "medium" | "high" =
    destructiveChangesCount || hasHighRiskSql ? "high" : relationshipChangesCount || hasMediumRiskSql ? "medium" : "low";

  return {
    affectedTablesCount: affectedTables.size,
    destructiveChangesCount,
    relationshipChangesCount,
    risk,
  };
}

function migrationRiskLabel(risk: "low" | "medium" | "high", t: Translator) {
  if (risk === "high") return t("migration.risk.high");
  if (risk === "medium") return t("migration.risk.medium");
  return t("migration.risk.low");
}

export default function Home() {
  const [workspace, setWorkspace] = useState<WorkspaceStore>(emptyWorkspace);
  const [session, setSession] = useState<Session | null>(null);
  const bootedRef = useRef(false);
  const aiChatsLoadedRef = useRef(false);
  const projectImportInputRef = useRef<HTMLInputElement>(null);
  const activeProjectHistoryStartRef = useRef<string | undefined>(undefined);
  const [localMode, setLocalMode] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [authBusy, setAuthBusy] = useState(false);
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [userPanelCollapsed, setUserPanelCollapsed] = useState(true);
  const [projectsPanelCollapsed, setProjectsPanelCollapsed] = useState(true);
  const [viewsPanelCollapsed, setViewsPanelCollapsed] = useState(true);
  const [tablesFocusMode, setTablesFocusMode] = useState(false);
  const [tableFilter, setTableFilter] = useState("");
  const [activeUserId, setActiveUserId] = useState<string>();
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [activeViewIds, setActiveViewIds] = useState<Record<string, string>>({});
  const [closedViewIdsByProject, setClosedViewIdsByProject] = useState<Record<string, string[]>>({});
  const [projectHistory, setProjectHistory] = useState<Record<string, ProjectHistoryEntry>>({});
  const [selectedTableId, setSelectedTableId] = useState<string>();
  const [fkBuilder, setFkBuilder] = useState<{
    active: boolean;
    sourceTableId?: string;
    tool: RelationTool;
  }>({ active: false, tool: "non-identifying-one-to-many" });
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saveBeforeMigrationOpen, setSaveBeforeMigrationOpen] = useState(false);
  const [pendingProjectAction, setPendingProjectAction] = useState<ProjectNavigationAction>();
  const [pendingDeleteProjectId, setPendingDeleteProjectId] = useState<string>();
  const [deletingProject, setDeletingProject] = useState(false);
  const [pendingDeleteTableId, setPendingDeleteTableId] = useState<string>();
  const [pendingDeleteRelationId, setPendingDeleteRelationId] = useState<string>();
  const [pendingDeleteViewId, setPendingDeleteViewId] = useState<string>();
  const [migrationCollapsed, setMigrationCollapsed] = useState(false);
  const [migrationPanelHeight, setMigrationPanelHeight] = useState(MIGRATION_PANEL_MIN_HEIGHT);
  const [migrationResize, setMigrationResize] = useState<{ startY: number; startHeight: number }>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importingProject, setImportingProject] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [projectBrowserOpen, setProjectBrowserOpen] = useState(true);
  const [migrationsBrowserOpen, setMigrationsBrowserOpen] = useState(false);
  const [userProfileOpen, setUserProfileOpen] = useState(false);
  const [migrationPage, setMigrationPage] = useState(0);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createProjectName, setCreateProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [copyProjectOpen, setCopyProjectOpen] = useState(false);
  const [copyProjectName, setCopyProjectName] = useState("");
  const [copyingProject, setCopyingProject] = useState(false);
  const [shareProjectId, setShareProjectId] = useState<string>();
  const [shareProjectEmail, setShareProjectEmail] = useState("");
  const [sharingProject, setSharingProject] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(360);
  const [inspectorResize, setInspectorResize] = useState<{ startX: number; startWidth: number }>();
  const [aiPanelWidth, setAiPanelWidth] = useState(AI_PANEL_MIN_WIDTH);
  const [aiPanelResize, setAiPanelResize] = useState<{ startX: number; startWidth: number }>();
  const [inspectorColumnsCollapsed, setInspectorColumnsCollapsed] = useState(false);
  const [inspectorRelationsCollapsed, setInspectorRelationsCollapsed] = useState(false);
  const [inspectorIndexesCollapsed, setInspectorIndexesCollapsed] = useState(false);
  const [expandedFkColumnKey, setExpandedFkColumnKey] = useState<string>();
  const [fkTargetSearch, setFkTargetSearch] = useState("");
  const [columnFilter, setColumnFilter] = useState("");
  const [indexFilter, setIndexFilter] = useState("");
  const [expandedColumnIds, setExpandedColumnIds] = useState<string[]>([]);
  const [expandedRelationIds, setExpandedRelationIds] = useState<string[]>([]);
  const [expandedIndexIds, setExpandedIndexIds] = useState<string[]>([]);
  const [expandedRelationTableKey, setExpandedRelationTableKey] = useState<string>();
  const [relationTableSearch, setRelationTableSearch] = useState("");
  const [expandedRelationColumnKey, setExpandedRelationColumnKey] = useState<string>();
  const [relationColumnSearch, setRelationColumnSearch] = useState("");
  const [inspectorDraggedColumnId, setInspectorDraggedColumnId] = useState<string>();
  const [inspectorColumnDropTargetId, setInspectorColumnDropTargetId] = useState<string>();
  const [createViewOpen, setCreateViewOpen] = useState(false);
  const [createViewName, setCreateViewName] = useState("");
  const [importing, setImporting] = useState(false);
  const [migration, setMigration] = useState<GeneratedMigration>();
  const [migrationDescriptionId, setMigrationDescriptionId] = useState<string>();
  const [migrationDescriptionCopied, setMigrationDescriptionCopied] = useState(false);
  const [describingMigrationId, setDescribingMigrationId] = useState<string>();
  const [copiedIndexId, setCopiedIndexId] = useState<string>();
  const [generating, setGenerating] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInput, setAiInput] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiChatsByProject, setAiChatsByProject] = useState<Record<string, AiChatSession[]>>({});
  const [activeAiChatIds, setActiveAiChatIds] = useState<Record<string, string>>({});
  const [aiChatListPages, setAiChatListPages] = useState<Record<string, number>>({});
  const [aiChatMode, setAiChatMode] = useState<"list" | "chat">("list");
  const [aiProposal, setAiProposal] = useState<AiProposal>();
  const [projectContextOpen, setProjectContextOpen] = useState(false);
  const [projectContextProjectId, setProjectContextProjectId] = useState<string>();
  const [projectContextDraft, setProjectContextDraft] = useState("");
  const [projectContextSaving, setProjectContextSaving] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreviewTable[]>();
  const [error, setError] = useState<string>();
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMessage, setProfileMessage] = useState("");
  const [profileDraft, setProfileDraft] = useState({ name: "", email: "", password: "", locale: "en" as Locale });
  const [importForm, setImportForm] = useState<ImportFormState>({
    supabaseUrl: SUPABASE_URL,
    connectionString: "",
    host: "",
    port: "5432",
    database: "postgres",
    username: "postgres",
    password: "",
    schema: "public",
    ssl: true,
    saveConnectionSettings: true,
  });

  const supabase = useMemo(() => getBrowserSupabase(), []);
  const accessToken = session?.access_token;
  const activeUser = workspace.users.find((user) => user.id === activeUserId);
  const activeLocale = normalizeLocale(activeUser?.locale);
  const t = useMemo(() => createTranslator(activeLocale), [activeLocale]);

  const authHeaders = useCallback(
    (tokenOverride?: string): Record<string, string> => {
      if (localMode) return {};
      const token = tokenOverride ?? accessToken;
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
    [accessToken, localMode],
  );

  const loadWorkspace = useCallback(
    async (token?: string, preferredProjectId?: string) => {
      const response = await fetch("/api/workspace", {
        headers: authHeaders(token),
      });
      const data = (await response.json()) as WorkspaceStore;
      if (!response.ok) {
        throw new Error(t("error.loadWorkspace"));
      }
      setWorkspace(data);
      setHasUnsavedChanges(false);
      const userId = data.users[0]?.id;
      const storedUserId = !token && !accessToken ? window.localStorage.getItem("dbopenstudio:user") : undefined;
      const nextUserId = storedUserId || userId;
      setActiveUserId(nextUserId);
      const firstProjectRaw =
        data.projects.find((item) => item.id === preferredProjectId) ??
        data.projects.find((project) => project.userId === nextUserId || project.sharedUserIds?.includes(nextUserId ?? "")) ??
        data.projects[0];
      const firstProject = firstProjectRaw ? projectWithActiveView(firstProjectRaw) : undefined;
      setActiveProjectId(firstProject?.id);
      setSelectedTableId(firstProject?.canvas.nodes[0]?.id);
    },
    [accessToken, authHeaders, t],
  );

  useEffect(() => {
    if (bootedRef.current && !localMode) return;
    bootedRef.current = true;

    if (!supabase || localMode) {
      loadWorkspace()
        .catch((err: Error) => setError(err.message))
        .finally(() => setLoading(false));
      return;
    }

    supabase.auth
      .getSession()
      .then(({ data }) => {
        setSession(data.session);
        if (data.session) {
          return loadWorkspace(data.session.access_token);
        }
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) {
        setLoading(true);
        loadWorkspace(nextSession.access_token)
          .catch((err: Error) => setError(err.message))
          .finally(() => setLoading(false));
      } else {
        setWorkspace(emptyWorkspace());
        setActiveUserId(undefined);
        setActiveProjectId(undefined);
        setSelectedTableId(undefined);
      }
    });

    return () => listener.subscription.unsubscribe();
  }, [loadWorkspace, localMode, supabase]);

  useEffect(() => {
    if (!AI_ENABLED || aiChatsLoadedRef.current) return;
    aiChatsLoadedRef.current = true;
    try {
      const storedChats = window.localStorage.getItem(AI_CHATS_STORAGE_KEY);
      const storedActiveChats = window.localStorage.getItem(AI_ACTIVE_CHATS_STORAGE_KEY);
      if (storedChats) setAiChatsByProject(JSON.parse(storedChats) as Record<string, AiChatSession[]>);
      if (storedActiveChats) setActiveAiChatIds(JSON.parse(storedActiveChats) as Record<string, string>);
    } catch {
      window.localStorage.removeItem(AI_CHATS_STORAGE_KEY);
      window.localStorage.removeItem(AI_ACTIVE_CHATS_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (!AI_ENABLED || !aiChatsLoadedRef.current) return;
    window.localStorage.setItem(AI_CHATS_STORAGE_KEY, JSON.stringify(aiChatsByProject));
  }, [aiChatsByProject]);

  useEffect(() => {
    if (!AI_ENABLED || !aiChatsLoadedRef.current) return;
    window.localStorage.setItem(AI_ACTIVE_CHATS_STORAGE_KEY, JSON.stringify(activeAiChatIds));
  }, [activeAiChatIds]);

  useEffect(() => {
    if (!inspectorResize) return;
    const resize = inspectorResize;

    function handleMouseMove(event: MouseEvent) {
      const maxWidth = Math.max(360, Math.min(720, window.innerWidth - 620));
      setInspectorWidth(Math.min(maxWidth, Math.max(360, resize.startWidth + resize.startX - event.clientX)));
    }

    function handleMouseUp() {
      setInspectorResize(undefined);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [inspectorResize]);

  useEffect(() => {
    if (!aiPanelResize) return;
    const resize = aiPanelResize;

    function handleMouseMove(event: MouseEvent) {
      const maxWidth = Math.max(AI_PANEL_MIN_WIDTH, Math.min(AI_PANEL_MAX_WIDTH, window.innerWidth - 620));
      setAiPanelWidth(Math.min(maxWidth, Math.max(AI_PANEL_MIN_WIDTH, resize.startWidth + resize.startX - event.clientX)));
    }

    function handleMouseUp() {
      setAiPanelResize(undefined);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [aiPanelResize]);

  useEffect(() => {
    if (!migrationResize) return;
    const resize = migrationResize;

    function handleMouseMove(event: MouseEvent) {
      const maxHeight = Math.max(MIGRATION_PANEL_MIN_HEIGHT, Math.min(640, window.innerHeight - 220));
      setMigrationPanelHeight(Math.min(maxHeight, Math.max(MIGRATION_PANEL_MIN_HEIGHT, resize.startHeight + resize.startY - event.clientY)));
    }

    function handleMouseUp() {
      setMigrationResize(undefined);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [migrationResize]);

  useEffect(() => {
    setColumnFilter("");
    setIndexFilter("");
    setExpandedColumnIds([]);
    setExpandedRelationIds([]);
    setExpandedIndexIds([]);
    setExpandedRelationTableKey(undefined);
    setRelationTableSearch("");
    setExpandedRelationColumnKey(undefined);
    setRelationColumnSearch("");
    setInspectorDraggedColumnId(undefined);
    setInspectorColumnDropTargetId(undefined);
  }, [selectedTableId]);

  useEffect(() => {
    if (activeUserId && (localMode || !session)) window.localStorage.setItem("dbopenstudio:user", activeUserId);
  }, [activeUserId, localMode, session]);

  useEffect(() => {
    setProfileDraft({
      name: activeUser?.name ?? "",
      email: activeUser?.email ?? "",
      password: "",
      locale: activeLocale,
    });
    setProfileMessage("");
  }, [activeLocale, activeUser?.email, activeUser?.name, activeUser?.id]);

  useEffect(() => {
    setImportPreview(undefined);
  }, [importForm]);

  async function submitAuth() {
    if (!supabase) return;
    setAuthBusy(true);
    setError(undefined);
    try {
      const email = authForm.email.trim();
      const password = authForm.password;
      const result =
        authMode === "signup"
          ? await supabase.auth.signUp({
              email,
              password,
              options: { data: { display_name: authForm.name.trim() || email.split("@")[0] } },
            })
          : await supabase.auth.signInWithPassword({ email, password });

      if (result.error) throw result.error;
      if (result.data.session) {
        setLocalMode(false);
        setSession(result.data.session);
        setLoading(true);
        await loadWorkspace(result.data.session.access_token);
        setLoading(false);
        return;
      }
      if (authMode === "signup" && !result.data.session) {
        setError(t("auth.signupNeedsConfirmation"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.error"));
      setLoading(false);
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut();
    bootedRef.current = false;
    setSession(null);
  }

  const projects = useMemo(
    () =>
      workspace.projects.filter(
        (item) => activeUserId && (item.userId === activeUserId || item.sharedUserIds?.includes(activeUserId)),
      ),
    [activeUserId, workspace.projects],
  );
  const baseProject = useMemo(
    () => projects.find((item) => item.id === activeProjectId) ?? projects[0],
    [activeProjectId, projects],
  );
  const project = useMemo(
    () => (baseProject ? projectWithActiveView(baseProject, activeViewIds[baseProject.id]) : undefined),
    [activeViewIds, baseProject],
  );
  const projectTablesById = useMemo(
    () => new Map(project?.model.tables.map((table) => [table.id, table]) ?? []),
    [project?.model.tables],
  );
  const projectColumnsByKey = useMemo(() => {
    const columns = new Map<string, DbColumn>();
    project?.model.tables.forEach((table) => {
      table.columns.forEach((column) => {
        columns.set(`${table.id}:${column.id}`, column);
      });
    });
    return columns;
  }, [project?.model.tables]);
  const filteredProjectTables = useMemo(
    () =>
      project?.model.tables.filter((table) => {
      const query = tableFilter.trim().toLowerCase();
      if (!query) return true;
      return `${table.schema}.${table.name}`.toLowerCase().includes(query);
      }) ?? [],
    [project?.model.tables, tableFilter],
  );
  const selectedTable = useMemo(
    () => (selectedTableId ? projectTablesById.get(selectedTableId) : undefined),
    [projectTablesById, selectedTableId],
  );
  const foreignKeyTargetOptions = useMemo<ForeignKeyTargetOption[]>(
    () =>
      project?.model.tables.flatMap((table) =>
        table.columns.map((column) => ({
          value: `${table.id}:${column.id}`,
          label: `${table.name}.${column.name}`,
          searchText: `${table.schema}.${table.name}.${column.name}`.toLowerCase(),
          tableId: table.id,
          columnId: column.id,
        })),
      ) ?? [],
    [project?.model.tables],
  );
  const relationTableOptions = useMemo(
    () => tableSearchOptions(project?.model.tables ?? []),
    [project?.model.tables],
  );
  const relationsBySourceColumn = useMemo(() => {
    const byColumn = new Map<string, DbRelation>();
    project?.model.relations.forEach((relation) => {
      byColumn.set(`${relation.fromTableId}:${relation.fromColumnId}`, relation);
    });
    return byColumn;
  }, [project?.model.relations]);
  const projectRelationsByTable = useMemo(() => {
    const byTable = new Map<string, DbRelation[]>();
    project?.model.relations.forEach((relation) => {
      const fromRelations = byTable.get(relation.fromTableId) ?? [];
      fromRelations.push(relation);
      byTable.set(relation.fromTableId, fromRelations);
      const toRelations = byTable.get(relation.toTableId) ?? [];
      if (relation.toTableId !== relation.fromTableId) toRelations.push(relation);
      byTable.set(relation.toTableId, toRelations);
    });
    return byTable;
  }, [project?.model.relations]);
  const selectedTableRelations = useMemo(
    () => (selectedTableId ? (projectRelationsByTable.get(selectedTableId) ?? []) : []),
    [projectRelationsByTable, selectedTableId],
  );
  const filteredSelectedTableColumns = useMemo(() => {
    const query = columnFilter.trim().toLowerCase();
    const columns = selectedTable?.columns ?? [];
    if (!query) return columns;
    return columns.filter((column) => `${column.name} ${column.type}`.toLowerCase().includes(query));
  }, [columnFilter, selectedTable?.columns]);
  const filteredSelectedTableIndexes = useMemo(() => {
    const query = indexFilter.trim().toLowerCase();
    const indexes = selectedTable?.indexes ?? [];
    if (!query) return indexes;
    return indexes.filter((index) => index.name.toLowerCase().includes(query));
  }, [indexFilter, selectedTable?.indexes]);
  const userMigrations = useMemo(
    () => workspace.migrations.filter((item) => item.projectId === project?.id),
    [project?.id, workspace.migrations],
  );
  const describedMigration = userMigrations.find((item) => item.id === migrationDescriptionId);
  const describedMigrationStats = describedMigration ? migrationReviewStats(describedMigration) : undefined;
  const projectExportFilename = useMemo(
    () => `${project?.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "dbopenstudio"}_project.json`,
    [project?.name],
  );
  const projectAiChats = project ? (aiChatsByProject[project.id] ?? []) : [];
  const visibleAiChats = projectAiChats
    .filter((chat) => !chat.archived)
    .toSorted((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  const aiChatPage = project ? (aiChatListPages[project.id] ?? 0) : 0;
  const aiChatPageCount = Math.max(1, Math.ceil(visibleAiChats.length / AI_CHAT_PAGE_SIZE));
  const normalizedAiChatPage = Math.min(aiChatPage, aiChatPageCount - 1);
  const pagedAiChats = visibleAiChats.slice(
    normalizedAiChatPage * AI_CHAT_PAGE_SIZE,
    normalizedAiChatPage * AI_CHAT_PAGE_SIZE + AI_CHAT_PAGE_SIZE,
  );
  const activeAiChatId = project ? activeAiChatIds[project.id] : undefined;
  const activeAiChat = visibleAiChats.find((chat) => chat.id === activeAiChatId) ?? visibleAiChats[0];
  const aiMessages = activeAiChat?.messages ?? [];
  const currentProjectHistory = project ? projectHistory[project.id] : undefined;
  const canUndoProject = Boolean(project && currentProjectHistory?.undo.length);
  const canRedoProject = Boolean(project && currentProjectHistory?.redo.length);
  function projectNameExists(name: string, exceptProjectId?: string) {
    const normalizedName = normalizedProjectName(name);
    return Boolean(
      normalizedName &&
        projects.some((item) => item.id !== exceptProjectId && normalizedProjectName(item.name) === normalizedName),
    );
  }

  function migrationAuthorLabel(targetMigration: GeneratedMigration) {
    const author = workspace.users.find((user) => user.id === targetMigration.userId);
    return (
      targetMigration.userEmail ??
      targetMigration.userName ??
      author?.email ??
      author?.name ??
      t("common.userFallback")
    );
  }

  function workspaceErrorMessage(message: unknown, fallbackKey: TranslationKey) {
    if (typeof message !== "string") return t(fallbackKey);
    if (message.includes("That user does not exist")) return t("error.shareProjectUserNotFound");
    if (message.includes("Only the project owner")) return t("error.shareProjectOwnerOnly");
    if (message.includes("owner already has access")) return t("error.shareProjectSelf");
    if (message.includes("A user with this email already exists")) return t("profile.emailExists");
    return message || t(fallbackKey);
  }

  function availableProjectName(baseName: string, suffix: string) {
    const base = baseName.trim() || t("common.defaultProjectName");
    if (!projectNameExists(base)) return base;
    const suffixed = `${base} - ${suffix}`;
    if (!projectNameExists(suffixed)) return suffixed;
    let count = 2;
    while (projectNameExists(`${suffixed} ${count}`)) {
      count += 1;
    }
    return `${suffixed} ${count}`;
  }

  const copyProjectNameInvalid = !copyProjectName.trim() || projectNameExists(copyProjectName);
  const createProjectNameInvalid = !createProjectName.trim() || projectNameExists(createProjectName);
  const pendingDeleteProject = projects.find((item) => item.id === pendingDeleteProjectId);
  const pendingDeleteProjectIsOwner = Boolean(pendingDeleteProject && pendingDeleteProject.userId === activeUserId);
  const shareProjectTarget = projects.find((item) => item.id === shareProjectId);
  const projectViews = project?.views ?? [];
  const closedViewIds = project ? (closedViewIdsByProject[project.id] ?? []) : [];
  const visibleProjectViews = project
    ? projectViews.filter((view) => !closedViewIds.includes(view.id))
    : [];
  const displayedProjectViews =
    visibleProjectViews.length || !project ? visibleProjectViews : projectViews.filter((view) => view.id === project.activeViewId).slice(0, 1);
  const pendingDeleteView = projectViews.find((view) => view.id === pendingDeleteViewId);
  const pendingDeleteRelation = project?.model.relations.find((relation) => relation.id === pendingDeleteRelationId);
  const mainGridStyle = {
    "--inspector-width": `${inspectorWidth}px`,
    "--ai-panel-width": `${aiPanelWidth}px`,
  } as CSSProperties;

  useEffect(() => {
    if (!AI_ENABLED || !project?.id) return;
    setAiChatsByProject((current) => {
      if (current[project.id]?.length) return current;
      const chat = createAiChatSession("Chat 1");
      setActiveAiChatIds((ids) => ({ ...ids, [project.id]: chat.id }));
      return { ...current, [project.id]: [chat] };
    });
  }, [project?.id]);

  useEffect(() => {
    if (!project?.id || aiChatPage === normalizedAiChatPage) return;
    setAiChatListPages((current) => ({ ...current, [project.id]: normalizedAiChatPage }));
  }, [aiChatPage, normalizedAiChatPage, project?.id]);

  useEffect(() => {
    const pageCount = Math.max(1, Math.ceil(userMigrations.length / MIGRATION_PAGE_SIZE));
    if (migrationPage > pageCount - 1) {
      setMigrationPage(pageCount - 1);
    }
  }, [migrationPage, userMigrations.length]);

  useEffect(() => {
    setMigrationDescriptionCopied(false);
  }, [migrationDescriptionId]);

  useEffect(() => {
    setExpandedFkColumnKey(undefined);
  }, [selectedTableId]);

  function updateActiveAiChat(updater: (chat: AiChatSession) => AiChatSession) {
    if (!project || !activeAiChat) return;
    setAiChatsByProject((current) => ({
      ...current,
      [project.id]: (current[project.id] ?? []).map((chat) =>
        chat.id === activeAiChat.id ? compactAiSession(updater(chat), t) : chat,
      ),
    }));
  }

  function createAiChat() {
    if (!project) return;
    const chat = createAiChatSession(t("ai.newChat"));
    setAiChatsByProject((current) => ({ ...current, [project.id]: [...(current[project.id] ?? []), chat] }));
    setActiveAiChatIds((current) => ({ ...current, [project.id]: chat.id }));
    setAiChatListPages((current) => ({ ...current, [project.id]: 0 }));
    setAiChatMode("chat");
    setAiProposal(undefined);
  }

  function openAiChat(chatId: string) {
    if (!project) return;
    setActiveAiChatIds((current) => ({ ...current, [project.id]: chatId }));
    setAiChatMode("chat");
    setAiProposal(undefined);
  }

  function archiveAiChat(chatId: string) {
    if (!project) return;
    const timestamp = nowLocalIso();
    const nextVisibleChat = visibleAiChats.find((chat) => chat.id !== chatId);
    setAiChatsByProject((current) => ({
      ...current,
      [project.id]: (current[project.id] ?? []).map((chat) =>
        chat.id === chatId ? { ...chat, archived: true, archivedAt: timestamp, updatedAt: timestamp } : chat,
      ),
    }));
    setActiveAiChatIds((current) => ({
      ...current,
      [project.id]: activeAiChat?.id === chatId ? (nextVisibleChat?.id ?? "") : (current[project.id] ?? ""),
    }));
    if (activeAiChat?.id === chatId) {
      setAiProposal(undefined);
      setAiChatMode("list");
    }
  }

  function setAiChatPage(nextPage: number) {
    if (!project) return;
    const page = Math.min(Math.max(nextPage, 0), aiChatPageCount - 1);
    setAiChatListPages((current) => ({ ...current, [project.id]: page }));
  }

  async function openImportModal() {
    if (project) {
      const storedSettings = await loadStoredImportSettings(project.id).catch(() => undefined);
      if (storedSettings) {
        setImportForm(storedSettings);
      } else if (project.connection) {
        setImportForm((current) => ({
          ...current,
          supabaseUrl: project.connection?.supabaseUrl ?? "",
          connectionString: "",
          host: project.connection?.host ?? "",
          port: String(project.connection?.port ?? 5432),
          database: project.connection?.database ?? "postgres",
          username: project.connection?.username ?? "postgres",
          password: "",
          schema: project.connection?.schema ?? "public",
          ssl: project.connection?.ssl ?? true,
        }));
      }
    }
    setImportPreview(undefined);
    setImportOpen(true);
  }

  function pushProjectHistory(projectId: string, snapshot: VisualProject) {
    setProjectHistory((current) => {
      const history = current[projectId] ?? { undo: [], redo: [] };
      return {
        ...current,
        [projectId]: {
          undo: [...history.undo, cloneProjectSnapshot(snapshot)].slice(-PROJECT_HISTORY_LIMIT),
          redo: [],
        },
      };
    });
  }

  function setProject(nextProject: VisualProject, options: ProjectChangeOptions = {}) {
    const syncedProject = syncActiveViewCanvas(nextProject, nextProject.activeViewId ?? activeViewIds[nextProject.id]);
    const previousProject = project?.id === syncedProject.id ? project : workspace.projects.find((item) => item.id === syncedProject.id);
    const historySnapshot = options.historySnapshot ?? previousProject;
    if (options.history !== false && historySnapshot) {
      pushProjectHistory(syncedProject.id, historySnapshot);
    }
    setHasUnsavedChanges(true);
    setMigration(undefined);
    setWorkspace((current) => updateProjectInStore(current, syncedProject.id, () => syncedProject));
  }

  function beginCanvasProjectChange() {
    if (!project || activeProjectHistoryStartRef.current === project.id) return;
    activeProjectHistoryStartRef.current = project.id;
    pushProjectHistory(project.id, project);
  }

  function endCanvasProjectChange() {
    activeProjectHistoryStartRef.current = undefined;
  }

  function restoreProjectFromHistory(nextProject: VisualProject) {
    const syncedProject = syncActiveViewCanvas(nextProject, nextProject.activeViewId ?? activeViewIds[nextProject.id]);
    setHasUnsavedChanges(true);
    setMigration(undefined);
    setActiveProjectId(syncedProject.id);
    setActiveViewIds((current) => ({ ...current, [syncedProject.id]: syncedProject.activeViewId ?? current[syncedProject.id] ?? "" }));
    setSelectedTableId((current) =>
      current && syncedProject.model.tables.some((table) => table.id === current) && syncedProject.canvas.nodes.some((node) => node.id === current)
        ? current
        : syncedProject.canvas.nodes[0]?.id,
    );
    setFkBuilder((current) => ({ active: false, tool: current.tool }));
    setWorkspace((current) => updateProjectInStore(current, syncedProject.id, () => syncedProject));
  }

  function undoProjectChange() {
    if (!project) return;
    const history = projectHistory[project.id];
    const previousProject = history?.undo.at(-1);
    if (!previousProject) return;
    setProjectHistory((current) => {
      const entry = current[project.id] ?? { undo: [], redo: [] };
      return {
        ...current,
        [project.id]: {
          undo: entry.undo.slice(0, -1),
          redo: [cloneProjectSnapshot(project), ...entry.redo].slice(0, PROJECT_HISTORY_LIMIT),
        },
      };
    });
    restoreProjectFromHistory(previousProject);
  }

  function redoProjectChange() {
    if (!project) return;
    const history = projectHistory[project.id];
    const nextProject = history?.redo[0];
    if (!nextProject) return;
    setProjectHistory((current) => {
      const entry = current[project.id] ?? { undo: [], redo: [] };
      return {
        ...current,
        [project.id]: {
          undo: [...entry.undo, cloneProjectSnapshot(project)].slice(-PROJECT_HISTORY_LIMIT),
          redo: entry.redo.slice(1),
        },
      };
    });
    restoreProjectFromHistory(nextProject);
  }

  function startFkTool(tool: RelationTool) {
    if (!project) return;
    if (project.canvas.nodes.length < 2) {
      setError(t("error.needTwoTablesForFk"));
      return;
    }
    setError(undefined);
    setFkBuilder((current) =>
      current.active && current.tool === tool
        ? { active: false, tool }
        : { active: true, sourceTableId: undefined, tool },
    );
  }

  function clearCanvasSelection() {
    setSelectedTableId(undefined);
    setFkBuilder((current) => ({ active: false, tool: current.tool }));
  }

  function pickFkTable(tableId: string) {
    if (!project) return;

    if (!fkBuilder.sourceTableId) {
      setFkBuilder((current) => ({ ...current, active: true, sourceTableId: tableId }));
      setSelectedTableId(tableId);
      return;
    }

    const nextProject = createForeignKeyBetweenTables(project, fkBuilder.sourceTableId, tableId, fkBuilder.tool);
    setProject(nextProject);
    setSelectedTableId(tableId);
    setFkBuilder((current) => ({ active: false, tool: current.tool }));
  }

  async function reloadWorkspace(preferredProjectId?: string) {
    await loadWorkspace(undefined, preferredProjectId);
  }

  async function createUserFromPrompt() {
    const name = window.prompt(t("sidebar.userNamePrompt"));
    if (!name) return;

    const response = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ action: "createUser", name }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error);
      return;
    }
    await reloadWorkspace();
    setActiveUserId(data.user.id);
  }

  async function updateActiveUserLocale(locale: Locale) {
    if (!activeUser) return;
    setWorkspace((current) => ({
      ...current,
      users: current.users.map((user) => (user.id === activeUser.id ? { ...user, locale } : user)),
    }));
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ action: "updateUser", userId: activeUser.id, user: { locale } }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setWorkspace((current) => ({
        ...current,
        users: current.users.map((user) => (user.id === activeUser.id ? data.user : user)),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.saveProject"));
      await reloadWorkspace(activeProjectId);
    }
  }

  function openUserProfile(userId = activeUserId) {
    if (!userId) return;
    setActiveUserId(userId);
    setProjectBrowserOpen(false);
    setMigrationsBrowserOpen(false);
    setUserProfileOpen(true);
    setAiOpen(false);
    setSelectedTableId(undefined);
    setFkBuilder((current) => ({ active: false, tool: current.tool }));
  }

  function openProjectHome() {
    setUserProfileOpen(false);
    setMigrationsBrowserOpen(false);
    setProjectBrowserOpen(true);
    setAiOpen(false);
    setSelectedTableId(undefined);
    setFkBuilder((current) => ({ active: false, tool: current.tool }));
  }

  function selectActiveUser(userId: string, openProfile = false) {
    setActiveUserId(userId);
    const firstProjectRaw = workspace.projects.find((item) => item.userId === userId || item.sharedUserIds?.includes(userId));
    const firstProject = firstProjectRaw ? projectWithActiveView(firstProjectRaw) : undefined;
    setActiveProjectId(firstProject?.id);
    setSelectedTableId(firstProject?.canvas.nodes[0]?.id);
    setFkBuilder((current) => ({ active: false, tool: current.tool }));
    if (openProfile) openUserProfile(userId);
  }

  async function saveUserProfile() {
    if (!activeUser) return;
    const nextName = profileDraft.name.trim() || activeUser.name;
    const nextEmail = profileDraft.email.trim();
    const nextLocale = normalizeLocale(profileDraft.locale);
    const nextPassword = profileDraft.password;
    const emailChanged = nextEmail !== (activeUser.email ?? "");
    const passwordChanged = Boolean(nextPassword);
    const duplicateEmail = workspace.users.some(
      (user) => user.id !== activeUser.id && user.email?.trim().toLowerCase() === nextEmail.toLowerCase(),
    );
    if (nextEmail && duplicateEmail) {
      setError(t("profile.emailExists"));
      return;
    }

    setProfileSaving(true);
    setError(undefined);
    setProfileMessage("");
    try {
      if (emailChanged && nextEmail) {
        const emailCheckResponse = await fetch("/api/workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ action: "checkUserEmail", userId: activeUser.id, email: nextEmail }),
        });
        const emailCheckData = await emailCheckResponse.json();
        if (!emailCheckResponse.ok) throw new Error(emailCheckData.error);
      }

      if (supabase && session && !localMode) {
        const authUpdate: Parameters<typeof supabase.auth.updateUser>[0] = {
          data: { display_name: nextName, locale: nextLocale },
        };
        if (emailChanged && nextEmail) authUpdate.email = nextEmail;
        if (passwordChanged) authUpdate.password = nextPassword;
        if (emailChanged || passwordChanged || nextName !== activeUser.name || nextLocale !== activeLocale) {
          const { error: authError } = await supabase.auth.updateUser(authUpdate);
          if (authError) throw authError;
        }
      }

      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          action: "updateUser",
          userId: activeUser.id,
          user: {
            name: nextName,
            locale: nextLocale,
            ...(localMode || !session ? { email: nextEmail } : {}),
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setWorkspace((current) => ({
        ...current,
        users: current.users.map((user) =>
          user.id === activeUser.id
            ? {
                ...user,
                ...data.user,
                name: nextName,
                locale: nextLocale,
                email: localMode || !session ? (nextEmail || undefined) : user.email,
              }
            : user,
        ),
      }));
      setProfileDraft((current) => ({ ...current, password: "" }));
      setProfileMessage(emailChanged && session ? t("profile.emailChangePending") : t("profile.saved"));
    } catch (err) {
      setError(workspaceErrorMessage(err instanceof Error ? err.message : undefined, "profile.saveError"));
      await reloadWorkspace(activeProjectId);
    } finally {
      setProfileSaving(false);
    }
  }

  async function createProject() {
    if (!activeUserId) return;
    const name = createProjectName.trim();
    if (!name) return;
    if (projectNameExists(name)) {
      setError(t("error.projectNameExists"));
      return;
    }

    setCreatingProject(true);
    setError(undefined);
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ action: "createProject", userId: activeUserId, name }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error);
        return;
      }
      await reloadWorkspace(data.project.id);
      setCreateProjectOpen(false);
      setProjectBrowserOpen(false);
      setUserProfileOpen(false);
      setCreateProjectName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.createProject"));
    } finally {
      setCreatingProject(false);
    }
  }

  function openCreateProjectModal() {
    setCreateProjectName("");
    setCreateProjectOpen(true);
  }

  function openCopyProjectModal() {
    if (!project) return;
    setCopyProjectName(`${project.name} - copy`);
    setCopyProjectOpen(true);
  }

  async function duplicateProject() {
    if (!activeUserId || !project) return;
    const name = copyProjectName.trim();
    if (!name) return;
    if (projectNameExists(name)) {
      setError(t("error.projectNameExists"));
      return;
    }

    setCopyingProject(true);
    setError(undefined);
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          action: "duplicateProject",
          userId: activeUserId,
          name,
          project,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || t("error.copyProject"));
        return;
      }
      await reloadWorkspace(data.project.id);
      setHasUnsavedChanges(false);
      setCopyProjectOpen(false);
      setCopyProjectName("");
      setProjectBrowserOpen(false);
      setUserProfileOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.copyProject"));
    } finally {
      setCopyingProject(false);
    }
  }

  function openShareProjectModal(projectId: string) {
    setShareProjectId(projectId);
    setShareProjectEmail("");
  }

  async function shareProjectWithUser() {
    if (!activeUserId || !shareProjectTarget) return;
    const email = shareProjectEmail.trim();
    if (!email) return;
    setSharingProject(true);
    setError(undefined);
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          action: "shareProject",
          projectId: shareProjectTarget.id,
          userId: activeUserId,
          email,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(workspaceErrorMessage(data.error, "error.shareProject"));
      await reloadWorkspace(activeProjectId);
      setShareProjectId(undefined);
      setShareProjectEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.shareProject"));
    } finally {
      setSharingProject(false);
    }
  }

  async function deleteOrUnlinkProject() {
    if (!activeUserId || !pendingDeleteProject) return;
    setDeletingProject(true);
    setError(undefined);
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          action: "deleteProject",
          projectId: pendingDeleteProject.id,
          userId: activeUserId,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(workspaceErrorMessage(data.error, "error.deleteProject"));
      const nextPreferredProject = activeProjectId === pendingDeleteProject.id ? undefined : activeProjectId;
      await reloadWorkspace(nextPreferredProject);
      if (activeProjectId === pendingDeleteProject.id) {
        setProjectBrowserOpen(true);
        setUserProfileOpen(false);
        setMigrationsBrowserOpen(false);
        setMigration(undefined);
        setSelectedTableId(undefined);
      }
      setPendingDeleteProjectId(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.deleteProject"));
    } finally {
      setDeletingProject(false);
    }
  }

  function performProjectAction(action: ProjectNavigationAction) {
    if (action.type === "createProject") {
      openCreateProjectModal();
      return;
    }

    const targetProject = projects.find((item) => item.id === action.projectId);
    if (!targetProject) return;
    const nextProject = projectWithActiveView(targetProject, activeViewIds[targetProject.id]);
    setActiveProjectId(targetProject.id);
    setSelectedTableId(nextProject.canvas.nodes[0]?.id);
    setFkBuilder((current) => ({ active: false, tool: current.tool }));
    if (action.closeBrowser) {
      setProjectBrowserOpen(false);
    }
    setUserProfileOpen(false);
    setMigrationsBrowserOpen(false);
  }

  function requestProjectAction(action: ProjectNavigationAction) {
    if (action.type === "selectProject" && action.projectId === project?.id) {
      if (action.closeBrowser) {
        setProjectBrowserOpen(false);
        setUserProfileOpen(false);
      }
      return;
    }
    if (hasUnsavedChanges && project) {
      setPendingProjectAction(action);
      return;
    }
    performProjectAction(action);
  }

  async function continueProjectActionWithoutSaving() {
    const action = pendingProjectAction;
    if (!action) return;
    setPendingProjectAction(undefined);
    if (action.type === "selectProject") {
      await reloadWorkspace(action.projectId);
      if (action.closeBrowser) setProjectBrowserOpen(false);
      return;
    }
    await reloadWorkspace(project?.id);
    openCreateProjectModal();
  }

  async function saveAndContinueProjectAction() {
    const action = pendingProjectAction;
    if (!action) return;
    const saved = await saveProject();
    if (!saved) return;
    setPendingProjectAction(undefined);
    performProjectAction(action);
  }

  function openProjectContext(targetProject: VisualProject) {
    const nextProject = projectWithActiveView(targetProject, activeViewIds[targetProject.id]);
    setActiveProjectId(targetProject.id);
    setSelectedTableId(nextProject.canvas.nodes[0]?.id);
    setProjectContextProjectId(targetProject.id);
    setProjectContextDraft(normalizeProjectAiContext(targetProject.aiContext) ?? "");
    setProjectContextOpen(true);
  }

  async function saveProjectContext() {
    if (!projectContextProjectId) return;
    const targetProject = workspace.projects.find((item) => item.id === projectContextProjectId);
    if (!targetProject) return;
    const normalizedAiContext = normalizeProjectAiContext(projectContextDraft);
    setProjectContextSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          action: "updateProject",
          projectId: targetProject.id,
          project: {
            name: targetProject.name,
            description: targetProject.description,
            aiContext: normalizedAiContext,
            connection: targetProject.connection,
            snapshot: targetProject.snapshot,
            model: targetProject.model,
            canvas: targetProject.canvas,
            views: targetProject.views,
            activeViewId: targetProject.activeViewId,
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("error.saveAiContext"));
      setWorkspace((current) =>
        updateProjectInStore(current, targetProject.id, (item) => ({ ...item, aiContext: normalizedAiContext })),
      );
      setProjectContextOpen(false);
      setProjectContextProjectId(undefined);
      setProjectContextDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.saveAiContext"));
    } finally {
      setProjectContextSaving(false);
    }
  }

  function switchView(viewId: string) {
    if (!project) return;
    const nextProject = projectWithActiveView(project, viewId);
    setActiveViewIds((current) => ({ ...current, [project.id]: viewId }));
    setSelectedTableId(nextProject.canvas.nodes[0]?.id);
    setFkBuilder((current) => ({ active: false, tool: current.tool }));
    setProjectBrowserOpen(false);
    setUserProfileOpen(false);
    setMigrationsBrowserOpen(false);
  }

  function openViewTab(viewId: string) {
    if (!project) return;
    setClosedViewIdsByProject((current) => ({
      ...current,
      [project.id]: (current[project.id] ?? []).filter((id) => id !== viewId),
    }));
    switchView(viewId);
  }

  function closeViewTab(viewId: string) {
    if (!project) return;
    const visibleViews = (project.views ?? []).filter((view) => !(closedViewIdsByProject[project.id] ?? []).includes(view.id));
    if (visibleViews.length <= 1) return;
    const remainingVisibleViews = visibleViews.filter((view) => view.id !== viewId);
    setClosedViewIdsByProject((current) => ({
      ...current,
      [project.id]: Array.from(new Set([...(current[project.id] ?? []), viewId])),
    }));
    if (project.activeViewId === viewId) {
      const nextView = remainingVisibleViews[0];
      if (nextView) {
        const nextProject = projectWithActiveView(project, nextView.id);
        setActiveViewIds((current) => ({ ...current, [project.id]: nextView.id }));
        setSelectedTableId(nextProject.canvas.nodes[0]?.id);
        setFkBuilder((current) => ({ active: false, tool: current.tool }));
      }
    }
  }

  function createView() {
    if (!project) return;
    const name = createViewName.trim() || t("view.defaultName", { count: (project.views?.length ?? 0) + 1 });
    const view = createCanvasView(name, emptyCanvas());
    const nextProject: VisualProject = {
      ...project,
      canvas: view.canvas,
      views: [...(project.views ?? []), view],
      activeViewId: view.id,
    };
    setClosedViewIdsByProject((current) => ({
      ...current,
      [project.id]: (current[project.id] ?? []).filter((id) => id !== view.id),
    }));
    setActiveViewIds((current) => ({ ...current, [project.id]: view.id }));
    setSelectedTableId(undefined);
    setCreateViewOpen(false);
    setCreateViewName("");
    setProject(nextProject);
  }

  function deleteView(viewId: string) {
    if (!project) return;
    const currentViews = project.views ?? [];
    if (currentViews.length <= 1) {
      setPendingDeleteViewId(undefined);
      return;
    }
    const nextViews = currentViews.filter((view) => view.id !== viewId);
    const nextActiveView =
      project.activeViewId === viewId
        ? nextViews.find((view) => view.isPrimary) ?? nextViews[0]
        : nextViews.find((view) => view.id === project.activeViewId) ?? nextViews[0];
    if (!nextActiveView) return;
    const nextProject: VisualProject = {
      ...project,
      canvas: nextActiveView.canvas,
      views: nextViews,
      activeViewId: nextActiveView.id,
    };
    setClosedViewIdsByProject((current) => ({
      ...current,
      [project.id]: (current[project.id] ?? []).filter((id) => id !== viewId && id !== nextActiveView.id),
    }));
    setActiveViewIds((current) => ({ ...current, [project.id]: nextActiveView.id }));
    setSelectedTableId(nextActiveView.canvas.nodes[0]?.id);
    setPendingDeleteViewId(undefined);
    setProject(nextProject);
  }

  function renameView(viewId: string, name: string) {
    if (!project) return;
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setProject({
      ...project,
      views: (project.views ?? []).map((view) => (view.id === viewId ? { ...view, name: trimmedName } : view)),
    });
  }

  async function saveProject() {
    if (!project) return false;
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          action: "updateProject",
          projectId: project.id,
          project: {
            name: project.name,
            description: project.description,
            aiContext: project.aiContext,
            connection: project.connection,
            snapshot: project.snapshot,
            model: project.model,
            canvas: project.canvas,
            views: project.views,
            activeViewId: project.activeViewId,
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      await reloadWorkspace(project.id);
      setHasUnsavedChanges(false);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.saveProject"));
      return false;
    } finally {
      setSaving(false);
    }
  }

  function addTable() {
    if (!project) return;
    const visibleCount = project.canvas.nodes.length;
    const x = 140 + (visibleCount % 4) * 300;
    const y = 140 + Math.floor(visibleCount / 4) * 210;
    const { table, node } = createTable(`table_${project.model.tables.length + 1}`, x, y);
    setProject({
      ...project,
      model: { ...project.model, tables: [...project.model.tables, table] },
      canvas: { ...project.canvas, nodes: [...project.canvas.nodes, node] },
    });
    setSelectedTableId(table.id);
  }

  function isTableOnCanvas(tableId: string) {
    return Boolean(project?.canvas.nodes.some((node) => node.id === tableId));
  }

  function toggleTableOnCanvas(tableId: string) {
    if (!project) return;
    const visible = project.canvas.nodes.some((node) => node.id === tableId);

    if (visible) {
      const nextNodes = project.canvas.nodes.filter((node) => node.id !== tableId);
      setProject({
        ...project,
        canvas: {
          ...project.canvas,
          nodes: nextNodes,
        },
      });
      if (selectedTableId === tableId) {
        setSelectedTableId(nextNodes[0]?.id);
      }
      return;
    }

    const tableIndex = project.model.tables.findIndex((table) => table.id === tableId);
    if (tableIndex === -1) return;

    setProject({
      ...project,
      canvas: {
        ...project.canvas,
        nodes: [
          ...project.canvas.nodes,
          {
            id: tableId,
            position: { x: 120 + (project.canvas.nodes.length % 4) * 280, y: 120 + Math.floor(project.canvas.nodes.length / 4) * 180 },
            width: DEFAULT_TABLE_NODE_WIDTH,
            height: Math.max(
              DEFAULT_TABLE_NODE_HEIGHT,
              58 + project.model.tables[tableIndex].columns.length * 32,
            ),
          },
        ],
      },
    });
    setSelectedTableId(tableId);
  }

  function updateTable(tableId: string, input: Partial<DbTable>) {
    if (!project) return;
    setProject({
      ...project,
      model: {
        ...project.model,
        tables: project.model.tables.map((table) => (table.id === tableId ? { ...table, ...input } : table)),
      },
    });
  }

  function deleteTable(tableId: string) {
    if (!project) return;
    setProject({
      ...project,
      model: {
        ...project.model,
        tables: project.model.tables.filter((table) => table.id !== tableId),
        relations: project.model.relations.filter(
          (relation) => relation.fromTableId !== tableId && relation.toTableId !== tableId,
        ),
      },
      canvas: {
        ...project.canvas,
        nodes: project.canvas.nodes.filter((node) => node.id !== tableId),
      },
    });
    setSelectedTableId(project.canvas.nodes.find((node) => node.id !== tableId)?.id);
    setPendingDeleteTableId(undefined);
  }

  function hideTableFromCanvas(tableId: string) {
    if (!project) return;
    const nextNodes = project.canvas.nodes.filter((node) => node.id !== tableId);
    setProject({
      ...project,
      canvas: {
        ...project.canvas,
        nodes: nextNodes,
      },
    });
    if (selectedTableId === tableId) {
      setSelectedTableId(nextNodes[0]?.id);
    }
  }

  function updateColumn(tableId: string, columnId: string, input: Partial<DbColumn>) {
    if (!project) return;
    setProject({
      ...project,
      model: {
        ...project.model,
        tables: project.model.tables.map((table) =>
          table.id === tableId
            ? {
                ...table,
                columns: table.columns.map((column) =>
                  column.id === columnId
                    ? { ...column, ...input, nullable: input.primaryKey ? false : (input.nullable ?? column.nullable) }
                    : column,
                ),
              }
            : table,
        ),
      },
    });
  }

  function toggleInspectorRelation(relationId: string) {
    setExpandedRelationIds((current) =>
      current.includes(relationId) ? current.filter((id) => id !== relationId) : [...current, relationId],
    );
  }

  function toggleInspectorIndex(indexId: string) {
    setExpandedIndexIds((current) =>
      current.includes(indexId) ? current.filter((id) => id !== indexId) : [...current, indexId],
    );
  }

  function deleteRelation(relationId: string) {
    if (!project) return;
    setProject({
      ...project,
      model: {
        ...project.model,
        relations: project.model.relations.filter((relation) => relation.id !== relationId),
      },
    });
    setExpandedRelationIds((current) => current.filter((id) => id !== relationId));
    setPendingDeleteRelationId(undefined);
  }

  function updateRelation(relationId: string, input: Partial<DbRelation>) {
    if (!project) return;
    setProject({
      ...project,
      model: {
        ...project.model,
        relations: project.model.relations.map((relation) =>
          relation.id === relationId ? { ...relation, ...input } : relation,
        ),
      },
    });
  }

  function updateRelationTable(
    relationId: string,
    endpoint: "from" | "to",
    tableId: string,
  ) {
    if (!project) return;
    const table = findTable(project.model, tableId);
    const firstColumnId = table?.columns[0]?.id;
    if (!firstColumnId) return;
    updateRelation(
      relationId,
      endpoint === "from"
        ? { fromTableId: tableId, fromColumnId: firstColumnId }
        : { toTableId: tableId, toColumnId: firstColumnId },
    );
  }

  function toggleInspectorColumn(columnId: string) {
    setExpandedColumnIds((current) =>
      current.includes(columnId) ? current.filter((id) => id !== columnId) : [...current, columnId],
    );
  }

  function reorderColumn(tableId: string, columnId: string, targetColumnId: string) {
    if (!project || columnId === targetColumnId) return;
    setProject({
      ...project,
      model: {
        ...project.model,
        tables: project.model.tables.map((table) => {
          if (table.id !== tableId) return table;
          const fromIndex = table.columns.findIndex((column) => column.id === columnId);
          const toIndex = table.columns.findIndex((column) => column.id === targetColumnId);
          if (fromIndex < 0 || toIndex < 0) return table;
          const columns = [...table.columns];
          const [moved] = columns.splice(fromIndex, 1);
          columns.splice(toIndex, 0, moved);
          return { ...table, columns };
        }),
      },
    });
  }

  function startInspectorColumnDrag(event: React.MouseEvent<HTMLButtonElement>, tableId: string, columnId: string) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setInspectorDraggedColumnId(columnId);
    setInspectorColumnDropTargetId(columnId);

    let lastClientX = event.clientX;
    let lastClientY = event.clientY;

    function trackMouse(moveEvent: MouseEvent) {
      lastClientX = moveEvent.clientX;
      lastClientY = moveEvent.clientY;
      const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const columnElement = element?.closest<HTMLElement>(`.inspector-column-item[data-table-id="${tableId}"]`);
      if (columnElement?.dataset.columnId) {
        setInspectorColumnDropTargetId(columnElement.dataset.columnId);
      }
    }

    function onMouseUp() {
      setInspectorDraggedColumnId(undefined);
      setInspectorColumnDropTargetId(undefined);
      const element = document.elementFromPoint(lastClientX, lastClientY);
      const columnElement = element?.closest<HTMLElement>(`.inspector-column-item[data-table-id="${tableId}"]`);
      const targetColumnId = columnElement?.dataset.columnId;
      if (targetColumnId && targetColumnId !== columnId) {
        reorderColumn(tableId, columnId, targetColumnId);
      }
      window.removeEventListener("mousemove", trackMouse);
      window.removeEventListener("mouseup", onMouseUp);
    }

    window.addEventListener("mousemove", trackMouse);
    window.addEventListener("mouseup", onMouseUp);
  }

  function addColumn(tableId: string) {
    if (!project) return;
    const table = findTable(project.model, tableId);
    if (!table) return;
    const column = createColumn(`column_${table.columns.length + 1}`, {
      type: "text",
      nullable: true,
      primaryKey: false,
      defaultValue: undefined,
    });
    const nextColumnCount = table.columns.length + 1;
    setProject({
      ...project,
      model: {
        ...project.model,
        tables: project.model.tables.map((item) =>
          item.id === tableId ? { ...item, columns: [...item.columns, column] } : item,
        ),
      },
      canvas: {
        ...project.canvas,
        nodes: project.canvas.nodes.map((node) =>
          node.id === tableId && !node.collapsed
            ? {
                ...node,
                height: Math.max(node.height ?? DEFAULT_TABLE_NODE_HEIGHT, 58 + nextColumnCount * 32),
              }
            : node,
        ),
      },
    });
    setColumnFilter("");
    setExpandedColumnIds((current) => [...current, column.id]);
  }

  function deleteColumn(tableId: string, columnId: string) {
    if (!project) return;
    const table = findTable(project.model, tableId);
    if (!table) return;
    setProject({
      ...project,
      model: {
        ...project.model,
        tables: project.model.tables.map((item) =>
          item.id === tableId
            ? { ...item, columns: item.columns.filter((column) => column.id !== columnId) }
            : item,
        ),
        relations: project.model.relations.filter(
          (relation) => relation.fromColumnId !== columnId && relation.toColumnId !== columnId,
        ),
      },
    });
    setExpandedColumnIds((current) => current.filter((id) => id !== columnId));
  }

  function columnRelation(tableId: string, columnId: string) {
    return relationsBySourceColumn.get(`${tableId}:${columnId}`);
  }

  function setColumnForeignKey(tableId: string, columnId: string, targetValue: string) {
    if (!project) return;
    const sourceTable = findTable(project.model, tableId);
    const sourceColumn = sourceTable?.columns.find((column) => column.id === columnId);
    if (!sourceTable || !sourceColumn) return;

    const relationsWithoutColumn = project.model.relations.filter(
      (relation) => !(relation.fromTableId === tableId && relation.fromColumnId === columnId),
    );

    if (!targetValue) {
      setProject({
        ...project,
        model: {
          ...project.model,
          relations: relationsWithoutColumn,
        },
      });
      return;
    }

    const [targetTableId, targetColumnId] = targetValue.split(":");
  const targetTable = findTable(project.model, targetTableId);
  const targetColumn = targetTable?.columns.find((column) => column.id === targetColumnId);
  if (!targetTable || !targetColumn) return;
  const config = relationToolConfig(fkBuilder.tool);
  const columnConfig = config.manyToMany ? relationToolConfig("non-identifying-one-to-many") : config;

  const nextSourceColumn = {
    ...sourceColumn,
    type: targetColumn.type,
    nullable: sourceColumn.primaryKey || columnConfig.identifying ? false : sourceColumn.nullable,
    primaryKey: columnConfig.identifying ? true : sourceColumn.primaryKey,
    unique: columnConfig.cardinality === "one-to-one" ? true : sourceColumn.unique,
  };
  const relation: DbRelation = {
    id: crypto.randomUUID(),
    name: `${sourceTable.name}_${sourceColumn.name}_fkey`,
    cardinality: columnConfig.cardinality,
    identifying: columnConfig.identifying,
    fromTableId: sourceTable.id,
      fromColumnId: sourceColumn.id,
      toTableId: targetTable.id,
      toColumnId: targetColumn.id,
      onDelete: "no action",
      onUpdate: "no action",
    };

    setProject({
      ...project,
      model: {
        ...project.model,
        tables: project.model.tables.map((table) =>
          table.id === tableId
            ? {
                ...table,
                columns: table.columns.map((column) => (column.id === columnId ? nextSourceColumn : column)),
              }
            : table,
        ),
        relations: [...relationsWithoutColumn, relation],
      },
    });
  }

  function importRequestBody(mode: "preview" | "import", selectedTableKeys?: string[]) {
    if (!project) return undefined;
    return {
      projectId: project.id,
      mode,
      supabaseUrl: importForm.supabaseUrl || undefined,
      connectionString: importForm.connectionString || undefined,
      host: importForm.host || undefined,
      port: importForm.port,
      database: importForm.database,
      username: importForm.username,
      password: importForm.password || undefined,
      schema: importForm.schema || "public",
      ssl: importForm.ssl,
      saveConnectionSettings: importForm.saveConnectionSettings,
      selectedTableKeys,
    };
  }

  async function previewImportSchema() {
    if (!project) return;
    setImporting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/import-schema", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(importRequestBody("preview")),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setImportPreview(data.preview as ImportPreviewTable[]);
      if (importForm.saveConnectionSettings) {
        await saveStoredImportSettings(project.id, importForm);
      } else {
        removeStoredImportSettings(project.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.previewImport"));
    } finally {
      setImporting(false);
    }
  }

  async function applyImportSchema() {
    if (!project) return;
    const selectedTableKeys = importPreview?.filter((table) => table.selected).map((table) => table.key) ?? [];
    setImporting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/import-schema", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(importRequestBody("import", selectedTableKeys)),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (importForm.saveConnectionSettings) {
        await saveStoredImportSettings(project.id, importForm);
      } else {
        removeStoredImportSettings(project.id);
      }
      setImportOpen(false);
      setImportPreview(undefined);
      await reloadWorkspace(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.applyImport"));
    } finally {
      setImporting(false);
    }
  }

  async function runGenerateSql() {
    if (!project) return;
    setGenerating(true);
    setError(undefined);
    try {
      const response = await fetch("/api/generate-migration", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ projectId: project.id, userId: activeUserId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMigration(data.migration);
      setMigrationCollapsed(false);
      await reloadWorkspace(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.generateMigration"));
    } finally {
      setGenerating(false);
    }
  }

  async function generateSql() {
    if (!project) return;
    if (hasUnsavedChanges) {
      setSaveBeforeMigrationOpen(true);
      return;
    }
    await runGenerateSql();
  }

  async function saveAndGenerateSql() {
    const saved = await saveProject();
    if (!saved) return;
    setSaveBeforeMigrationOpen(false);
    await runGenerateSql();
  }

  async function sendAiMessage() {
    if (!project || !activeAiChat) return;
    const prompt = aiInput.trim();
    if (!prompt) return;

    const userMessage: AiChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
    };
    const nextMessages = [...activeAiChat.messages, userMessage];
    updateActiveAiChat((chat) => ({
      ...chat,
      title: chat.messages.length === 0 ? aiChatTitleFromPrompt(prompt) : chat.title,
      messages: nextMessages,
      updatedAt: nowLocalIso(),
    }));
    setAiInput("");
    setAiChatMode("chat");
    setAiBusy(true);
    setError(undefined);

    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          prompt,
          project,
          selectedTableId,
          locale: activeLocale,
          chatSummary: activeAiChat.summary,
          messages: nextMessages.slice(-8).map(({ role, content }) => ({ role, content })),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("ai.errorProposal"));
      const proposal = data.proposal as AiProposal;
      setAiProposal(proposal.changes.length ? proposal : undefined);
      updateActiveAiChat((chat) => ({
        ...chat,
        messages: [
          ...chat.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: [proposal.message, ...(proposal.changes.length ? [] : (proposal.warnings ?? []))]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        updatedAt: nowLocalIso(),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ai.errorProposal"));
    } finally {
      setAiBusy(false);
    }
  }

  function applyAiProposal() {
    if (!project || !aiProposal) return;
    const result = applyAiChanges(project, aiProposal.changes);
    if (!result.committed) {
      updateActiveAiChat((chat) => ({
        ...chat,
        messages: [
          ...chat.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: [
              t("ai.proposalNotApplied"),
              t("ai.proposalNotAppliedReason", { count: result.skipped.length }),
              result.skipped.slice(0, 3).join("\n"),
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        updatedAt: nowLocalIso(),
      }));
      return;
    }
    setProject(result.project);
    setAiProposal(undefined);
    if (selectedTableId && !result.project.model.tables.some((table) => table.id === selectedTableId)) {
      setSelectedTableId(result.project.canvas.nodes[0]?.id);
    }
    updateActiveAiChat((chat) => ({
      ...chat,
      messages: [
        ...chat.messages,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: [
            result.applied.length ? t("ai.appliedCount", { count: result.applied.length }) : t("ai.noChangesApplied"),
            result.skipped.length ? t("ai.skippedCount", { count: result.skipped.length }) : "",
            t("ai.reviewAndSave"),
          ]
            .filter(Boolean)
            .join(" "),
        },
      ],
      updatedAt: nowLocalIso(),
    }));
  }

  function cancelAiProposal() {
    setAiProposal(undefined);
    updateActiveAiChat((chat) => ({
      ...chat,
      messages: [
        ...chat.messages,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: t("ai.proposalDiscarded"),
        },
      ],
      updatedAt: nowLocalIso(),
    }));
  }

  function downloadMigration() {
    if (!migration) return;
    downloadMigrationFile(migration);
  }

  function downloadMigrationFile(targetMigration: GeneratedMigration) {
    const blob = new Blob([targetMigration.sql], { type: "text/sql" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${targetMigration.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "dbopenstudio"}_migration.sql`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function downloadProjectJson() {
    if (!project) return;
    const blob = new Blob([JSON.stringify(exportProject(project, userMigrations), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = projectExportFilename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function showMigrationInConsole(targetMigration: GeneratedMigration) {
    setMigration(targetMigration);
    setMigrationCollapsed(false);
  }

  function replaceMigrationInWorkspace(nextMigration: GeneratedMigration) {
    setWorkspace((current) => ({
      ...current,
      migrations: current.migrations.map((item) => (item.id === nextMigration.id ? nextMigration : item)),
    }));
    setMigration((current) => (current?.id === nextMigration.id ? nextMigration : current));
  }

  async function openMigrationDescription(targetMigration: GeneratedMigration) {
    setMigrationDescriptionId(targetMigration.id);
    if (targetMigration.aiDescription?.trim() || !project || !AI_ENABLED) return;
    setDescribingMigrationId(targetMigration.id);
    setError(undefined);
    try {
      const response = await fetch("/api/migration-description", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          migrationId: targetMigration.id,
          projectId: project.id,
          locale: activeLocale,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("migration.aiDescriptionError"));
      replaceMigrationInWorkspace(data.migration as GeneratedMigration);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("migration.aiDescriptionError"));
    } finally {
      setDescribingMigrationId(undefined);
    }
  }

  async function copyMigrationDescriptionText(targetMigration: GeneratedMigration) {
    if (!targetMigration.aiDescription?.trim()) return;
    await navigator.clipboard.writeText(targetMigration.aiDescription);
    setMigrationDescriptionCopied(true);
  }

  async function copyIndexSql(index: DbIndex, table: DbTable) {
    const sql = indexDefinitionSql(index, table);
    try {
      await navigator.clipboard.writeText(sql);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = sql;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopiedIndexId(index.id);
    window.setTimeout(() => setCopiedIndexId((current) => (current === index.id ? undefined : current)), 1600);
  }

  async function importProjectJson(file: File) {
    if (!activeUserId) return;
    setImportingProject(true);
    setError(undefined);
    try {
      const raw = await file.text();
      const parsed = parseProjectExport(JSON.parse(raw));
      const imported = parsed.project;
      const importedName = availableProjectName(imported.name, t("project.importedCopySuffix"));
      const createResponse = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          action: "createProject",
          userId: activeUserId,
          name: importedName,
        }),
      });
      const createData = await createResponse.json();
      if (!createResponse.ok) throw new Error(createData.error || t("error.createImportedProject"));
      const importedProject = createData.project as VisualProject;
      const activeImportedViewId =
        imported.activeViewId && imported.views.some((view) => view.id === imported.activeViewId)
          ? imported.activeViewId
          : imported.views.find((view) => view.isPrimary)?.id ?? imported.views[0].id;

      const updateResponse = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          action: "updateProject",
          projectId: importedProject.id,
          project: {
            name: importedName,
            description: imported.description,
            aiContext: imported.aiContext,
            connection: imported.connection,
            snapshot: imported.snapshot,
            model: imported.model,
            canvas: imported.canvas,
            views: imported.views,
            activeViewId: activeImportedViewId,
          },
        }),
      });
      const updateData = await updateResponse.json();
      if (!updateResponse.ok) throw new Error(updateData.error || t("error.importProject"));

      await reloadWorkspace(importedProject.id);
      setActiveViewIds((current) => ({ ...current, [importedProject.id]: activeImportedViewId }));
      setHasUnsavedChanges(false);
      setMigration(undefined);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.importProjectJson"));
    } finally {
      setImportingProject(false);
      if (projectImportInputRef.current) projectImportInputRef.current.value = "";
    }
  }

  if (loading) {
    return (
      <main className="loading-screen">
        <Loader2 className="spin" size={28} />
        <span>{t("common.loading")}</span>
      </main>
    );
  }

  if (supabase && !localMode && !session) {
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <div className="brand-row auth-brand-row">
            <div className="brand-copy brand-copy-logo">
              <Image
                className="brand-logo auth-brand-logo"
                src={BRAND_LOGO_SRC}
                alt="DB Open Studio"
                width={1378}
                height={335}
                priority
              />
              <p>{t("app.tagline")}</p>
            </div>
          </div>
          <div className="auth-tabs">
            <button
              className={authMode === "login" ? "auth-tab auth-tab-active" : "auth-tab"}
              onClick={() => setAuthMode("login")}
              type="button"
            >
              {t("auth.login")}
            </button>
            <button
              className={authMode === "signup" ? "auth-tab auth-tab-active" : "auth-tab"}
              onClick={() => setAuthMode("signup")}
              type="button"
            >
              {t("auth.signup")}
            </button>
          </div>
          {authMode === "signup" ? (
            <label>
              {t("auth.name")}
              <input
                autoComplete="name"
                value={authForm.name}
                onChange={(event) => setAuthForm({ ...authForm, name: event.target.value })}
              />
            </label>
          ) : null}
          <label>
            {t("auth.email")}
            <input
              autoComplete="email"
              type="email"
              value={authForm.email}
              onChange={(event) => setAuthForm({ ...authForm, email: event.target.value })}
            />
          </label>
          <label>
            {t("auth.password")}
            <input
              autoComplete={authMode === "login" ? "current-password" : "new-password"}
              type="password"
              value={authForm.password}
              onChange={(event) => setAuthForm({ ...authForm, password: event.target.value })}
            />
          </label>
          {error ? (
            <div className="error-banner auth-error">
              <AlertTriangle size={16} />
              {error}
            </div>
          ) : null}
          <button className="button primary auth-submit" disabled={authBusy} onClick={submitAuth} type="button">
            {authBusy ? <Loader2 className="spin" size={16} /> : <CircleUserRound size={16} />}
            {authMode === "login" ? t("auth.login") : t("auth.signup")}
          </button>
          <button
            className="button secondary auth-submit"
            onClick={() => {
              setLocalMode(true);
              setLoading(true);
              setError(undefined);
            }}
            type="button"
          >
            {t("auth.continueLocal")}
          </button>
        </section>
      </main>
    );
  }

  const mainGridClass = [
    "main-grid",
    projectBrowserOpen || migrationsBrowserOpen || userProfileOpen ? "main-grid-project-browser" : "",
    selectedTable && project && !projectBrowserOpen && !migrationsBrowserOpen && !userProfileOpen ? "" : "main-grid-inspector-hidden",
    AI_ENABLED && aiOpen && project && !projectBrowserOpen && !migrationsBrowserOpen && !userProfileOpen ? "main-grid-ai-open" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const projectsSidebarExpanded = userProfileOpen || !projectsPanelCollapsed;

  return (
    <main className={`app-shell ${sidebarCollapsed ? "app-shell-sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand-row">
          {!sidebarCollapsed ? (
          <button className="brand-copy brand-copy-logo brand-home-button" onClick={openProjectHome} type="button">
            <Image className="brand-logo" src={BRAND_LOGO_SRC} alt="DB Open Studio" width={1378} height={335} priority />
            <span>{t("app.shortTagline")}</span>
          </button>
          ) : (
          <button className="brand-mark brand-mark-image brand-home-button" onClick={openProjectHome} type="button">
            <Image src={BRAND_ICON_SRC} alt="DB Open Studio" width={425} height={335} priority />
          </button>
          )}
          <button
            className="icon-button sidebar-toggle"
            onClick={() => setSidebarCollapsed((current) => !current)}
            title={sidebarCollapsed ? t("sidebar.expand") : t("sidebar.collapse")}
            type="button"
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        {!sidebarCollapsed ? (
        <>
        {!tablesFocusMode ? (
        <section className={`stack sidebar-section ${userPanelCollapsed ? "sidebar-section-collapsed" : ""}`}>
          <button
            aria-expanded={!userPanelCollapsed}
            className="sidebar-section-head"
            onClick={() => setUserPanelCollapsed((current) => !current)}
            type="button"
          >
            <span>{t("sidebar.activeUser")}</span>
            {userPanelCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          </button>
          {userPanelCollapsed ? (
            <button
              className="sidebar-compact-row"
              onClick={() => openUserProfile()}
              type="button"
            >
              <CircleUserRound size={15} />
              <span>{activeUser?.name ?? t("common.userFallback")}</span>
            </button>
          ) : (
            <>
              <div className="row">
                <select
                  className="select"
                  value={activeUserId ?? ""}
                  onChange={(event) => {
                    selectActiveUser(event.target.value, true);
                  }}
                >
                  {workspace.users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-button"
                  onClick={session ? signOut : createUserFromPrompt}
                  title={session ? t("sidebar.signOut") : t("sidebar.createUser")}
                  type="button"
                >
                  {session ? <LogOut size={16} /> : <UserPlus size={16} />}
                </button>
              </div>
              <button className="user-pill user-pill-button" onClick={() => openUserProfile()} type="button">
                <CircleUserRound size={15} />
                <span>{activeUser?.email ?? activeUser?.name}</span>
              </button>
              <label className="language-field">
                <span>{t("sidebar.language")}</span>
                <select
                  className="select"
                  value={activeLocale}
                  onChange={(event) => void updateActiveUserLocale(normalizeLocale(event.target.value))}
                >
                  <option value="en">{t("sidebar.languageEnglish")}</option>
                  <option value="es">{t("sidebar.languageSpanish")}</option>
                  <option value="ca">{t("sidebar.languageCatalan")}</option>
                </select>
              </label>
            </>
          )}
        </section>
        ) : null}

        {!tablesFocusMode && !projectBrowserOpen ? (
        <section className={`stack sidebar-section ${projectsSidebarExpanded ? "" : "sidebar-section-collapsed"}`}>
          <div className="sidebar-section-title-row">
            <button
              aria-expanded={projectsSidebarExpanded}
              className="sidebar-section-head"
              onClick={() => setProjectsPanelCollapsed((current) => !current)}
              type="button"
            >
              <span>{t("sidebar.projects")}</span>
              {projectsSidebarExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </button>
            <button
              className="icon-button"
              onClick={() => requestProjectAction({ type: "createProject" })}
              title={t("sidebar.newProject")}
              type="button"
            >
              <FolderPlus size={16} />
            </button>
          </div>
          {!projectsSidebarExpanded ? (
            <button
              className="sidebar-compact-row"
              onClick={() => setProjectsPanelCollapsed(false)}
              type="button"
            >
              <FolderPlus size={15} />
              <span>{project?.name ?? t("sidebar.projectsCount", { count: projects.length })}</span>
              <small>{projects.length}</small>
            </button>
          ) : (
            <div className="project-list">
              {project ? (
                <div className="project-card project-card-active">
                  <button
                    className="project-item"
                    onClick={() => {
                      setUserProfileOpen(false);
                      setMigrationsBrowserOpen(false);
                      setProjectBrowserOpen(true);
                    }}
                    type="button"
                  >
                    <span>{project.name}</span>
                    <small>{t("sidebar.tablesCount", { count: project.model.tables.length })}</small>
                  </button>
                  {AI_ENABLED ? (
                    <button
                      className={`project-ai-info ${project.aiContext?.trim() ? "project-ai-info-filled" : ""}`}
                      onClick={() => openProjectContext(project)}
                      title={t("sidebar.projectAiContext")}
                      type="button"
                    >
                      <Info size={14} />
                    </button>
                  ) : null}
                </div>
              ) : null}
              <button
                className="project-show-all"
                onClick={() => {
                  setUserProfileOpen(false);
                  setMigrationsBrowserOpen(false);
                  setProjectBrowserOpen(true);
                }}
                type="button"
              >
                <span>{t("sidebar.viewAllProjects")}</span>
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </section>
        ) : null}

        {!tablesFocusMode && !projectBrowserOpen && !userProfileOpen && project ? (
        <section className="stack sidebar-section">
          <button
            className={`sidebar-section-head sidebar-nav-row ${migrationsBrowserOpen ? "sidebar-nav-row-active" : ""}`}
            onClick={() => {
              setUserProfileOpen(false);
              setProjectBrowserOpen(false);
              setMigrationsBrowserOpen(true);
              setMigrationPage(0);
            }}
            type="button"
          >
            <span>{t("sidebar.migrations")}</span>
            <ChevronRight size={15} />
          </button>
        </section>
        ) : null}

        {!tablesFocusMode && !projectBrowserOpen && !userProfileOpen && project ? (
        <section className={`stack sidebar-section ${viewsPanelCollapsed ? "sidebar-section-collapsed" : ""}`}>
          <div className="sidebar-section-title-row">
            <button
              aria-expanded={!viewsPanelCollapsed}
              className="sidebar-section-head"
              onClick={() => setViewsPanelCollapsed((current) => !current)}
              type="button"
            >
              <span>{t("views.projectViews")}</span>
              {viewsPanelCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
            </button>
            {!viewsPanelCollapsed ? (
            <button
              className="icon-button"
              onClick={() => {
                setCreateViewName("");
                setCreateViewOpen(true);
              }}
              title={t("views.newView")}
              type="button"
            >
              <Plus size={16} />
            </button>
            ) : null}
          </div>
          {!viewsPanelCollapsed ? (
            <div className="view-sidebar-list">
              {(project.views ?? []).map((view) => (
                <div className={`view-sidebar-card ${view.id === project.activeViewId ? "view-sidebar-card-active" : ""}`} key={view.id}>
                  <button className="view-sidebar-main" onClick={() => openViewTab(view.id)} type="button">
                    <span>{view.name}</span>
                    <small>{view.canvas.nodes.length}</small>
                  </button>
                  <button
                    className="view-sidebar-delete"
                    disabled={(project.views?.length ?? 0) <= 1}
                    onClick={() => setPendingDeleteViewId(view.id)}
                    title={t("views.deleteView")}
                    type="button"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </section>
        ) : null}

        {!projectBrowserOpen && !migrationsBrowserOpen && !userProfileOpen ? (
        <section className="stack tables-section">
          <div className="section-title">
            <button
              className="sidebar-section-head"
              onClick={() => setTablesFocusMode((current) => !current)}
              title={tablesFocusMode ? t("sidebar.showUserProjects") : t("sidebar.hideUserProjects")}
              type="button"
            >
              <span>{t("sidebar.tables")}</span>
              {tablesFocusMode ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
            </button>
            <button className="icon-button" onClick={addTable} title={t("sidebar.newTable")} type="button">
              <Plus size={16} />
            </button>
          </div>
          <input
            className="table-filter-input"
            placeholder={t("sidebar.filterTables")}
            value={tableFilter}
            onChange={(event) => setTableFilter(event.target.value)}
          />
          <div className="table-list">
            {filteredProjectTables.map((table) => {
              const onCanvas = isTableOnCanvas(table.id);
              return (
                <button
                  className={`table-list-item ${onCanvas ? "table-list-item-on-canvas" : ""} ${selectedTableId === table.id ? "table-list-item-active" : ""}`}
                  draggable
                  key={table.id}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("application/dbopenstudio", `table:${table.id}`);
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => toggleTableOnCanvas(table.id)}
                  title={onCanvas ? t("sidebar.removeFromCanvas") : t("sidebar.addToCanvas")}
                  type="button"
                >
                  {onCanvas ? <Check size={15} /> : <Table2 size={15} />}
                  <span>{table.name}</span>
                  <small>{table.columns.length}</small>
                </button>
              );
            })}
          </div>
        </section>
        ) : null}
        </>
        ) : null}
      </aside>

      <section className="workspace">
        <header className="topbar">
          {userProfileOpen ? (
            <>
              <div className="project-heading">
                <h2 className="topbar-title">{t("profile.title")}</h2>
                <span>{activeUser?.email ?? activeUser?.name ?? t("common.userFallback")}</span>
              </div>
              <div className="toolbar">
                <button className="button secondary" onClick={signOut} type="button">
                  <LogOut size={16} />
                  {t("sidebar.signOut")}
                </button>
              </div>
            </>
          ) : projectBrowserOpen ? (
            <>
              <div className="project-heading">
                <h2 className="topbar-title">{t("sidebar.projects")}</h2>
              </div>
              <div className="toolbar">
                <button className="button primary" onClick={() => requestProjectAction({ type: "createProject" })} type="button">
                  <FolderPlus size={16} />
                  {t("sidebar.newProject")}
                </button>
              </div>
            </>
          ) : migrationsBrowserOpen ? (
            <>
              <div className="project-heading">
                <h2 className="topbar-title">{t("sidebar.migrations")}</h2>
                <span>{project?.name ?? t("common.projectFallback")}</span>
              </div>
              <div className="toolbar">
                <button className="button primary" disabled={generating || !project} onClick={generateSql} type="button">
                  {generating ? <Loader2 className="spin" size={16} /> : <FileCode2 size={16} />}
                  {t("toolbar.generateMigration")}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="project-heading">
                <input
                  className="project-name-input"
                  disabled={!project}
                  value={project?.name ?? ""}
                  onChange={(event) => project && setProject({ ...project, name: event.target.value })}
                />
                <span>
                  {t("common.snapshot")}: {project?.snapshot ? new Date(project.snapshot.importedAt).toLocaleString() : t("common.notImported")}
                </span>
              </div>
              <div className="toolbar">
                <button className="button secondary" onClick={() => void openImportModal()} type="button">
                  <RefreshCw size={16} />
                  {t("toolbar.import")}
                </button>
                <button className="button primary" disabled={generating || !project} onClick={generateSql} type="button">
                  {generating ? <Loader2 className="spin" size={16} /> : <FileCode2 size={16} />}
                  {t("toolbar.generateMigration")}
                </button>
              </div>
            </>
          )}
        </header>

        {project && !projectBrowserOpen && !migrationsBrowserOpen && !userProfileOpen ? (
          <div className="view-tabs">
            <div className="view-tabs-list" role="tablist" aria-label={t("views.projectViews")}>
              {displayedProjectViews.map((view) => (
                <button
                  aria-selected={view.id === project.activeViewId}
                  className={`view-tab ${view.id === project.activeViewId ? "view-tab-active" : ""}`}
                  key={view.id}
                  onClick={() => switchView(view.id)}
                  onDoubleClick={() => {
                    const name = window.prompt(t("views.viewNamePrompt"), view.name);
                    if (name) renameView(view.id, name);
                  }}
                  role="tab"
                  title={view.isPrimary ? t("common.mainView") : t("views.openView")}
                  type="button"
                >
                  <span>{view.name}</span>
                  <small>{view.canvas.nodes.length}</small>
                  <span
                    aria-label={t("views.closeView")}
                    className="view-tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeViewTab(view.id);
                    }}
                    title={t("views.closeView")}
                  >
                    <X size={12} />
                  </span>
                </button>
              ))}
            </div>
            <button
              className="icon-button"
              onClick={() => {
                setCreateViewName("");
                setCreateViewOpen(true);
              }}
              title={t("views.newView")}
              type="button"
            >
              <Plus size={16} />
            </button>
          </div>
        ) : null}

        <div className={mainGridClass} style={mainGridStyle}>
          <div className="canvas-panel">
            {userProfileOpen ? (
              <UserProfileView
                canChangePassword={Boolean(session && supabase && !localMode)}
                draft={profileDraft}
                message={profileMessage}
                saving={profileSaving}
                user={activeUser}
                onDraftChange={setProfileDraft}
                onSave={() => void saveUserProfile()}
                onSignOut={() => void signOut()}
                t={t}
              />
            ) : projectBrowserOpen ? (
              <ProjectBrowser
                activeProjectId={project?.id}
                activeUserId={activeUserId}
                projects={projects}
                onDeleteProject={setPendingDeleteProjectId}
                onSelectProject={(projectId) => requestProjectAction({ type: "selectProject", projectId, closeBrowser: true })}
                onShareProject={openShareProjectModal}
                t={t}
              />
            ) : migrationsBrowserOpen ? (
              <MigrationsBrowser
                aiEnabled={AI_ENABLED}
                describingMigrationId={describingMigrationId}
                migrationAuthor={migrationAuthorLabel}
                migrations={userMigrations}
                page={migrationPage}
                onDescribe={(targetMigration) => void openMigrationDescription(targetMigration)}
                onDownload={downloadMigrationFile}
                onPageChange={setMigrationPage}
                onShowInConsole={showMigrationInConsole}
                t={t}
              />
            ) : project ? (
              <ReactFlowProvider>
                <WorkspaceCanvas
                  project={project}
                  relationMode={fkBuilder.active}
                  relationSourceTableId={fkBuilder.sourceTableId}
                  selectedTableId={selectedTableId}
                  onClearSelection={clearCanvasSelection}
                  onRelationPick={pickFkTable}
                  onProjectChangeStart={beginCanvasProjectChange}
                  onProjectChangeEnd={endCanvasProjectChange}
                  onProjectChange={setProject}
                  onSelectTable={setSelectedTableId}
                  t={t}
                />
              </ReactFlowProvider>
            ) : (
              <div className="empty-state">{t("canvas.empty")}</div>
            )}
          </div>

          {!projectBrowserOpen && !migrationsBrowserOpen && !userProfileOpen ? (
          <aside className="tool-panel">
            <div className="tool-panel-group">
              <button className="tool-button" disabled={!canUndoProject} onClick={undoProjectChange} title={t("tool.undo")} type="button">
                <Undo2 size={17} />
                <span>{t("tool.undo")}</span>
              </button>
              <button className="tool-button" disabled={!canRedoProject} onClick={redoProjectChange} title={t("tool.redo")} type="button">
                <Redo2 size={17} />
                <span>{t("tool.redo")}</span>
              </button>
              <button className="tool-button" onClick={clearCanvasSelection} title={t("tool.deselect")} type="button">
                <Hand size={17} />
                <span>{t("tool.deselect")}</span>
              </button>
              <button className="tool-button" disabled={!project} onClick={addTable} title={t("tool.addTable")} type="button">
                <Table2 size={17} />
                <span>{t("tool.addTable")}</span>
              </button>
              <span
                className="tool-button-tooltip-wrap"
                title={AI_ENABLED ? (aiOpen ? t("tool.closeAi") : t("tool.openAi")) : t("tool.aiDisabled")}
              >
                <button
                  className={`tool-button tool-button-ai ${aiOpen ? "button-active" : ""}`}
                  disabled={!AI_ENABLED || !project}
                  onClick={() => setAiOpen((current) => !current)}
                  title={AI_ENABLED ? (aiOpen ? t("tool.closeAi") : t("tool.openAi")) : t("tool.aiDisabled")}
                  type="button"
                >
                  <Sparkles size={17} />
                  <span aria-hidden="true">AI</span>
                </button>
              </span>
            </div>
            <div className="tool-panel-group tool-panel-relations">
              {relationToolConfigs.map((config) => (
                <button
                  aria-label={t(config.titleKey)}
                  className={`tool-button relation-tool-button ${fkBuilder.active && fkBuilder.tool === config.id ? "button-active" : ""}`}
                  disabled={!project}
                  key={config.id}
                  onClick={() => startFkTool(config.id)}
                  title={t(config.titleKey)}
                  type="button"
                >
                  <RelationToolIcon tool={config.id} />
                </button>
              ))}
            </div>
            <div className="tool-panel-group tool-panel-bottom">
              <input
                ref={projectImportInputRef}
                accept="application/json,.json"
                className="sr-only"
                data-testid="project-import-input"
                type="file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importProjectJson(file);
                }}
              />
              <button
                className="tool-button"
                disabled={importingProject || !activeUserId}
                onClick={() => projectImportInputRef.current?.click()}
                title={t("tool.importJson")}
                type="button"
              >
                {importingProject ? <Loader2 className="spin" size={17} /> : <Upload size={17} />}
                <span>{t("tool.importJson")}</span>
              </button>
              <button
                className="tool-button"
                disabled={!project}
                onClick={downloadProjectJson}
                title={t("tool.exportJson")}
                type="button"
              >
                <Download size={17} />
                <span>{t("tool.exportJson")}</span>
              </button>
              <button className="tool-button" disabled={saving || !project} onClick={saveProject} title={t("tool.save")} type="button">
                {saving ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
                <span>{t("tool.save")}</span>
              </button>
              <button className="tool-button" disabled={copyingProject || !project} onClick={openCopyProjectModal} title={t("tool.saveAsCopy")} type="button">
                {copyingProject ? <Loader2 className="spin" size={17} /> : <CopyPlus size={17} />}
                <span>{t("tool.saveAsCopy")}</span>
              </button>
              <button className="tool-button tool-button-primary" disabled={generating || !project} onClick={generateSql} title={t("toolbar.generateMigration")} type="button">
                {generating ? <Loader2 className="spin" size={17} /> : <FileCode2 size={17} />}
                <span>{t("tool.migration")}</span>
              </button>
            </div>
          </aside>
          ) : null}

          {selectedTable && project && !projectBrowserOpen && !migrationsBrowserOpen && !userProfileOpen ? (
          <aside className="inspector">
              <button
                aria-label={t("inspector.resize")}
                className="inspector-resize-handle"
                onMouseDown={(event) => {
                  event.preventDefault();
                  setInspectorResize({ startX: event.clientX, startWidth: inspectorWidth });
                }}
                title={t("inspector.resize")}
                type="button"
              />
              <>
                <div className="inspector-head">
                  <div className="inspector-table-title">
                    <div className="inspector-table-name">
                      <Table2 size={18} />
                      <span>{selectedTable.schema}.</span>
                      <strong>{selectedTable.name}</strong>
                    </div>
                  </div>
                  <div className="row">
                    <button className="icon-button" onClick={() => setSelectedTableId(undefined)} title={t("inspector.close")} type="button">
                      <X size={16} />
                    </button>
                    <button className="icon-button" onClick={() => hideTableFromCanvas(selectedTable.id)} title={t("inspector.hideFromCanvas")} type="button">
                      <EyeOff size={16} />
                    </button>
                    <button className="danger-icon" onClick={() => setPendingDeleteTableId(selectedTable.id)} title={t("inspector.deleteTable")} type="button">
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <p className="inspector-table-stats">
                    <span>{selectedTable.columns.length} {t("inspector.columnsCount")}</span>
                    <span>{selectedTableRelations.length} {t("inspector.fksCount")}</span>
                    <span>{selectedTable.indexes.length} {t("inspector.indexesCount")}</span>
                  </p>
                </div>

                <div className="form-grid">
                  <label>
                    {t("common.schema")}
                    <input
                      value={selectedTable.schema}
                      onChange={(event) => updateTable(selectedTable.id, { schema: event.target.value })}
                    />
                  </label>
                  <label>
                    {t("common.table")}
                    <input
                      value={selectedTable.name}
                      onChange={(event) => updateTable(selectedTable.id, { name: event.target.value })}
                    />
                  </label>
                </div>

                <section className={`inspector-section inspector-section-columns ${inspectorColumnsCollapsed ? "inspector-section-collapsed" : ""}`}>
                  <div className="section-title inspector-section-title">
                    <button className="sidebar-section-head" onClick={() => setInspectorColumnsCollapsed((current) => !current)} type="button">
                      <span>{t("inspector.columns")}</span>
                      {inspectorColumnsCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                    </button>
                    <button className="button secondary inspector-add-column" onClick={() => addColumn(selectedTable.id)} title={t("inspector.newColumn")} type="button">
                      <Plus size={15} />
                      <span>{t("inspector.newColumnShort")}</span>
                    </button>
                  </div>

                  {!inspectorColumnsCollapsed ? (
                  <div className="columns-editor">
                    <label className="column-filter">
                      <Search size={15} />
                      <input
                        placeholder={t("inspector.filterColumns")}
                        value={columnFilter}
                        onChange={(event) => setColumnFilter(event.target.value)}
                      />
                    </label>
                    {filteredSelectedTableColumns.map((column) => {
                    const fkRelation = columnRelation(selectedTable.id, column.id);
                    const fkValue = fkRelation ? `${fkRelation.toTableId}:${fkRelation.toColumnId}` : "";
                    const fkColumnKey = `${selectedTable.id}:${column.id}`;
                    const columnExpanded = expandedColumnIds.includes(column.id);
                    const fkTargetOption = fkValue
                      ? foreignKeyTargetOptions.find((option) => option.value === fkValue)
                      : undefined;
                    const fkOptions = foreignKeyTargetOptions.filter(
                      (option) => option.tableId !== selectedTable.id || option.columnId !== column.id,
                    );
                    const defaultValuePresets = defaultValuePresetsForType(column.type);
                    const activeDefaultPreset = defaultValuePresets.find(
                      (preset) => preset.value === (column.defaultValue ?? ""),
                    );
                    const defaultValueEditable = !activeDefaultPreset;

                    return (
                    <div
                      className={`column-editor inspector-column-item ${columnExpanded ? "column-editor-expanded" : ""} ${inspectorDraggedColumnId === column.id ? "inspector-column-dragging" : ""} ${inspectorColumnDropTargetId === column.id && inspectorDraggedColumnId !== column.id ? "inspector-column-drop-target" : ""}`}
                      data-column-id={column.id}
                      data-table-id={selectedTable.id}
                      key={column.id}
                    >
                      <div className="column-summary-row">
                        <button
                          aria-label={t("inspector.reorderColumn")}
                          className="column-drag-handle"
                          onMouseDown={(event) => startInspectorColumnDrag(event, selectedTable.id, column.id)}
                          title={t("inspector.reorderColumn")}
                          type="button"
                        >
                          <GripVertical size={15} />
                        </button>
                        <button
                          aria-expanded={columnExpanded}
                          className="column-summary-toggle"
                          onClick={() => toggleInspectorColumn(column.id)}
                          type="button"
                        >
                          <span className="column-summary-name">
                            {column.primaryKey ? (
                              <span className="column-marker column-marker-pk">
                                <KeyRound size={13} />
                              </span>
                            ) : (
                              <span
                                className={`column-marker column-marker-dot ${column.nullable ? "column-marker-nullable" : "column-marker-required"} ${fkRelation ? "column-marker-fk" : ""}`}
                              />
                            )}
                            <span>{column.name}</span>
                          </span>
                          <span className="column-summary-meta">
                            {!column.nullable ? <span className="column-nn-badge">NN</span> : null}
                            <span>{shortType(column.type)}</span>
                            {columnExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </span>
                        </button>
                      </div>
                      {columnExpanded ? (
                      <div className="column-editor-body">
                        <div className="check-row column-flags">
                          <label className={`column-flag ${column.primaryKey ? "column-flag-active" : ""}`}>
                            <input
                              checked={column.primaryKey}
                              className="sr-only"
                              onChange={(event) =>
                                updateColumn(selectedTable.id, column.id, { primaryKey: event.target.checked })
                              }
                              type="checkbox"
                            />
                            PK
                          </label>
                          <label className={`column-flag ${column.unique ? "column-flag-active" : ""}`}>
                            <input
                              checked={column.unique}
                              className="sr-only"
                              onChange={(event) =>
                                updateColumn(selectedTable.id, column.id, { unique: event.target.checked })
                              }
                              type="checkbox"
                            />
                            {t("inspector.unique")}
                          </label>
                          <label className={`column-flag ${column.nullable ? "column-flag-active" : ""} ${column.primaryKey ? "column-flag-disabled" : ""}`}>
                            <input
                              checked={column.nullable}
                              className="sr-only"
                              disabled={column.primaryKey}
                              onChange={(event) =>
                                updateColumn(selectedTable.id, column.id, { nullable: event.target.checked })
                              }
                              type="checkbox"
                            />
                            {t("inspector.nullable")}
                          </label>
                        </div>
                        <div className="column-editor-row">
                          <input
                            value={column.name}
                            onChange={(event) => updateColumn(selectedTable.id, column.id, { name: event.target.value })}
                          />
                          <select
                            value={columnTypes.includes(column.type) ? column.type : "text"}
                            onChange={(event) => updateColumn(selectedTable.id, column.id, { type: event.target.value })}
                          >
                            {columnTypes.map((type) => (
                              <option key={type} value={type}>
                                {type}
                              </option>
                            ))}
                          </select>
                          <button
                            className="danger-icon"
                            onClick={() => deleteColumn(selectedTable.id, column.id)}
                            title={t("inspector.deleteColumn")}
                            type="button"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                        <div className="default-preset-row">
                          <button
                            className={`default-preset ${defaultValueEditable ? "default-preset-active" : ""}`}
                            onClick={() => updateColumn(selectedTable.id, column.id, { defaultValue: undefined })}
                            type="button"
                          >
                            {t("inspector.defaultCustom")}
                          </button>
                          {defaultValuePresets.map((preset) => (
                            <button
                              className={`default-preset ${activeDefaultPreset?.value === preset.value ? "default-preset-active" : ""}`}
                              key={preset.value}
                              onClick={() => updateColumn(selectedTable.id, column.id, { defaultValue: preset.value })}
                              type="button"
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                        <input
                          className="default-input"
                          disabled={!defaultValueEditable}
                          placeholder="default SQL"
                          value={column.defaultValue ?? ""}
                          onChange={(event) =>
                            updateColumn(selectedTable.id, column.id, {
                              defaultValue: event.target.value || undefined,
                            })
                          }
                        />
                        <div className="fk-column-selector">
                          <span>FK</span>
                          <ForeignKeyTargetSelect
                            open={expandedFkColumnKey === fkColumnKey}
                            options={fkOptions}
                            search={expandedFkColumnKey === fkColumnKey ? fkTargetSearch : ""}
                            selectedOption={fkTargetOption}
                            t={t}
                            value={fkValue}
                            onChange={(nextValue) => {
                              setColumnForeignKey(selectedTable.id, column.id, nextValue);
                              setExpandedFkColumnKey(undefined);
                              setFkTargetSearch("");
                            }}
                            onClose={() => {
                              setExpandedFkColumnKey(undefined);
                              setFkTargetSearch("");
                            }}
                            onOpen={() => {
                              setExpandedFkColumnKey(fkColumnKey);
                              setFkTargetSearch("");
                            }}
                            onSearchChange={setFkTargetSearch}
                          />
                        </div>
                      </div>
                      ) : null}
                    </div>
                    );
                    })}
                    {!filteredSelectedTableColumns.length ? (
                      <p className="muted column-filter-empty">{t("inspector.noColumnsMatch")}</p>
                    ) : null}
                  </div>
                  ) : null}
                </section>

                <section className={`inspector-section inspector-section-relations ${inspectorRelationsCollapsed ? "inspector-section-collapsed" : ""}`}>
                  <div className="section-title relation-title inspector-section-title">
                    <button className="sidebar-section-head" onClick={() => setInspectorRelationsCollapsed((current) => !current)} type="button">
                      <span>{t("inspector.relations")}</span>
                      {inspectorRelationsCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                    </button>
                  </div>
                  {!inspectorRelationsCollapsed ? (
                  <div className="relation-list">
                  {selectedTableRelations.length ? (
                    selectedTableRelations.map((relation) => {
                      const relationExpanded = expandedRelationIds.includes(relation.id);
                      const fromTable = projectTablesById.get(relation.fromTableId);
                      const toTable = projectTablesById.get(relation.toTableId);
                      const fromColumnOptions = columnSearchOptions(fromTable);
                      const toColumnOptions = columnSearchOptions(toTable);
                      const fromTableSelectKey = `${relation.id}:from-table`;
                      const toTableSelectKey = `${relation.id}:to-table`;
                      const fromColumnSelectKey = `${relation.id}:from`;
                      const toColumnSelectKey = `${relation.id}:to`;

                      return (
                      <div className={`relation-item ${relationExpanded ? "relation-item-expanded" : ""}`} key={relation.id}>
                        <button
                          aria-expanded={relationExpanded}
                          className="relation-summary-toggle"
                          onClick={() => toggleInspectorRelation(relation.id)}
                          type="button"
                        >
                          <Link2 size={14} />
                          <span>{relationLabelFromIndexes(relation, projectTablesById, projectColumnsByKey, t)}</span>
                          {relationExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </button>
                        <button
                          className="danger-icon relation-delete-button"
                          onClick={() => setPendingDeleteRelationId(relation.id)}
                          title={t("relation.delete")}
                          type="button"
                        >
                          <Trash2 size={13} />
                        </button>
                        {relationExpanded ? (
                          <div className="relation-editor">
                            <label>
                              {t("relation.fkTable")}
                              <ForeignKeyTargetSelect
                                allowEmpty={false}
                                emptyLabel={t("relation.tableFallback")}
                                noResultsLabel={t("relation.noTableResults")}
                                open={expandedRelationTableKey === fromTableSelectKey}
                                options={relationTableOptions}
                                search={relationTableSearch}
                                searchPlaceholder={t("relation.searchTable")}
                                selectedOption={relationTableOptions.find((option) => option.value === relation.fromTableId)}
                                t={t}
                                value={relation.fromTableId}
                                onChange={(nextValue) => {
                                  updateRelationTable(relation.id, "from", nextValue);
                                  setExpandedRelationTableKey(undefined);
                                  setRelationTableSearch("");
                                }}
                                onClose={() => {
                                  setExpandedRelationTableKey(undefined);
                                  setRelationTableSearch("");
                                }}
                                onOpen={() => {
                                  setExpandedRelationTableKey(fromTableSelectKey);
                                  setRelationTableSearch("");
                                }}
                                onSearchChange={setRelationTableSearch}
                              />
                            </label>
                            <label>
                              {t("relation.fkColumn")}
                              <ForeignKeyTargetSelect
                                allowEmpty={false}
                                emptyLabel={t("relation.fieldFallback")}
                                noResultsLabel={t("relation.noFieldResults")}
                                open={expandedRelationColumnKey === fromColumnSelectKey}
                                options={fromColumnOptions}
                                search={relationColumnSearch}
                                searchPlaceholder={t("relation.searchField")}
                                selectedOption={fromColumnOptions.find((option) => option.value === relation.fromColumnId)}
                                t={t}
                                value={relation.fromColumnId}
                                onChange={(nextValue) => {
                                  updateRelation(relation.id, { fromColumnId: nextValue });
                                  setExpandedRelationColumnKey(undefined);
                                  setRelationColumnSearch("");
                                }}
                                onClose={() => {
                                  setExpandedRelationColumnKey(undefined);
                                  setRelationColumnSearch("");
                                }}
                                onOpen={() => {
                                  setExpandedRelationColumnKey(fromColumnSelectKey);
                                  setRelationColumnSearch("");
                                }}
                                onSearchChange={setRelationColumnSearch}
                              />
                            </label>
                            <label>
                              {t("relation.referencedTable")}
                              <ForeignKeyTargetSelect
                                allowEmpty={false}
                                emptyLabel={t("relation.tableFallback")}
                                noResultsLabel={t("relation.noTableResults")}
                                open={expandedRelationTableKey === toTableSelectKey}
                                options={relationTableOptions}
                                search={relationTableSearch}
                                searchPlaceholder={t("relation.searchTable")}
                                selectedOption={relationTableOptions.find((option) => option.value === relation.toTableId)}
                                t={t}
                                value={relation.toTableId}
                                onChange={(nextValue) => {
                                  updateRelationTable(relation.id, "to", nextValue);
                                  setExpandedRelationTableKey(undefined);
                                  setRelationTableSearch("");
                                }}
                                onClose={() => {
                                  setExpandedRelationTableKey(undefined);
                                  setRelationTableSearch("");
                                }}
                                onOpen={() => {
                                  setExpandedRelationTableKey(toTableSelectKey);
                                  setRelationTableSearch("");
                                }}
                                onSearchChange={setRelationTableSearch}
                              />
                            </label>
                            <label>
                              {t("relation.referencedColumn")}
                              <ForeignKeyTargetSelect
                                allowEmpty={false}
                                emptyLabel={t("relation.fieldFallback")}
                                noResultsLabel={t("relation.noFieldResults")}
                                open={expandedRelationColumnKey === toColumnSelectKey}
                                options={toColumnOptions}
                                search={relationColumnSearch}
                                searchPlaceholder={t("relation.searchField")}
                                selectedOption={toColumnOptions.find((option) => option.value === relation.toColumnId)}
                                t={t}
                                value={relation.toColumnId}
                                onChange={(nextValue) => {
                                  updateRelation(relation.id, { toColumnId: nextValue });
                                  setExpandedRelationColumnKey(undefined);
                                  setRelationColumnSearch("");
                                }}
                                onClose={() => {
                                  setExpandedRelationColumnKey(undefined);
                                  setRelationColumnSearch("");
                                }}
                                onOpen={() => {
                                  setExpandedRelationColumnKey(toColumnSelectKey);
                                  setRelationColumnSearch("");
                                }}
                                onSearchChange={setRelationColumnSearch}
                              />
                            </label>
                            <label>
                              {t("relation.onDelete")}
                              <select
                                value={relation.onDelete ?? "no action"}
                                onChange={(event) =>
                                  updateRelation(relation.id, { onDelete: event.target.value as DbRelation["onDelete"] })
                                }
                              >
                                {referentialActionOptions.map((action) => (
                                  <option key={action} value={action}>
                                    {t(`relation.action.${action}` as TranslationKey)}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              {t("relation.onUpdate")}
                              <select
                                value={relation.onUpdate ?? "no action"}
                                onChange={(event) =>
                                  updateRelation(relation.id, { onUpdate: event.target.value as DbRelation["onUpdate"] })
                                }
                              >
                                {referentialActionOptions.map((action) => (
                                  <option key={action} value={action}>
                                    {t(`relation.action.${action}` as TranslationKey)}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                        ) : null}
                      </div>
                      );
                    })
                  ) : (
                    <p className="muted">{t("relation.empty")}</p>
                  )}
                  </div>
                  ) : null}
                </section>

                <section className={`inspector-section inspector-section-indexes ${inspectorIndexesCollapsed ? "inspector-section-collapsed" : ""}`}>
                  <div className="section-title inspector-section-title">
                    <button className="sidebar-section-head" onClick={() => setInspectorIndexesCollapsed((current) => !current)} type="button">
                      <span>{t("inspector.indexes")}</span>
                      {inspectorIndexesCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                    </button>
                  </div>
                  {!inspectorIndexesCollapsed ? (
                    <div className="index-list">
                      {selectedTable.indexes.length ? (
                        <>
                          <label className="index-filter">
                            <Search size={15} />
                            <input
                              placeholder={t("index.filter")}
                              value={indexFilter}
                              onChange={(event) => setIndexFilter(event.target.value)}
                            />
                          </label>
                          {filteredSelectedTableIndexes.length ? (
                            filteredSelectedTableIndexes.map((index) => {
                              const columns = indexColumnsLabel(index, selectedTable, t);
                              const method = indexMethod(index);
                              const whereClause = indexWhereClause(index);
                              const sql = indexDefinitionSql(index, selectedTable);
                              const copied = copiedIndexId === index.id;
                              const indexExpanded = expandedIndexIds.includes(index.id);

                              return (
                                <article className={`index-item ${indexExpanded ? "index-item-expanded" : ""}`} key={index.id}>
                                  <button
                                    aria-expanded={indexExpanded}
                                    className="index-summary-toggle"
                                    onClick={() => toggleInspectorIndex(index.id)}
                                    type="button"
                                  >
                                    <div className="index-summary-content">
                                      <strong className="index-name">{index.name}</strong>
                                      <div className="index-badges">
                                        <span className={`index-badge ${index.unique ? "index-badge-unique" : ""}`}>
                                          {index.unique ? t("index.unique") : t("index.normal")}
                                        </span>
                                        <span className="index-badge">{method}</span>
                                      </div>
                                    </div>
                                    {indexExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                                  </button>
                                  <button
                                    aria-label={copied ? t("index.copied") : t("index.copySql")}
                                    className="icon-button index-copy-button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void copyIndexSql(index, selectedTable);
                                    }}
                                    title={copied ? t("index.copied") : t("index.copySql")}
                                    type="button"
                                  >
                                    {copied ? <Check size={14} /> : <Copy size={14} />}
                                  </button>
                                  {indexExpanded ? (
                                    <div className="index-detail">
                                      <p className="index-purpose">
                                        {index.unique
                                          ? t("index.uniquePurpose", { columns })
                                          : t("index.normalPurpose", { columns })}
                                      </p>
                                      <div className="index-meta">
                                        <span>{t("index.columns", { columns })}</span>
                                        {whereClause ? <span>{t("index.partial", { condition: whereClause })}</span> : null}
                                      </div>
                                      <pre className="index-sql"><code>{sql}</code></pre>
                                    </div>
                                  ) : null}
                                </article>
                              );
                            })
                          ) : (
                            <p className="muted index-empty">{t("index.noMatch")}</p>
                          )}
                        </>
                      ) : (
                        <p className="muted index-empty">{t("index.empty")}</p>
                      )}
                    </div>
                  ) : null}
                </section>
              </>
          </aside>
          ) : null}
          {AI_ENABLED && aiOpen && project && !projectBrowserOpen && !migrationsBrowserOpen ? (
            <aside className="ai-panel">
              <button
                aria-label={t("ai.resize")}
                className="ai-resize-handle"
                onMouseDown={(event) => {
                  event.preventDefault();
                  setAiPanelResize({ startX: event.clientX, startWidth: aiPanelWidth });
                }}
                title={t("ai.resize")}
                type="button"
              />
              <header className="ai-panel-head">
                <div>
                  <h2>AI</h2>
                  <p>{t("ai.assistant")}</p>
                </div>
                <button className="icon-button" onClick={() => setAiOpen(false)} title={t("tool.closeAi")} type="button">
                  x
                </button>
              </header>
              {aiChatMode === "list" ? (
                <div className="ai-chat-list-view">
                  <div className="ai-chat-list-head">
                    <div>
                      <strong>{t("ai.chats")}</strong>
                      <span>{visibleAiChats.length} {t("common.active")}</span>
                    </div>
                    <button className="button primary ai-chat-create" onClick={createAiChat} type="button">
                      <Plus size={15} />
                      {t("ai.new")}
                    </button>
                  </div>
                  <div className="ai-chat-list">
                    {pagedAiChats.length ? (
                      pagedAiChats.map((chat) => (
                        <div className="ai-chat-list-item" key={chat.id}>
                          <button className="ai-chat-list-main" onClick={() => openAiChat(chat.id)} type="button">
                            <span>{chat.title}</span>
                            <small>
                              {chat.messages.length} {t("common.messages")} · {formatAiChatTimestamp(chat.updatedAt, t)}
                            </small>
                          </button>
                          <button
                            className="icon-button ai-chat-archive"
                            onClick={() => archiveAiChat(chat.id)}
                            title={t("ai.archiveChat")}
                            type="button"
                          >
                            <Archive size={14} />
                          </button>
                        </div>
                      ))
                    ) : (
                      <div className="ai-empty">
                        {t("ai.emptyChats")}
                      </div>
                    )}
                  </div>
                  {aiChatPageCount > 1 ? (
                    <div className="ai-chat-pagination">
                      <button
                        className="button secondary"
                        disabled={normalizedAiChatPage === 0}
                        onClick={() => setAiChatPage(normalizedAiChatPage - 1)}
                        type="button"
                      >
                        {t("ai.recent")}
                      </button>
                      <span>
                        {normalizedAiChatPage + 1} / {aiChatPageCount}
                      </span>
                      <button
                        className="button secondary"
                        disabled={normalizedAiChatPage >= aiChatPageCount - 1}
                        onClick={() => setAiChatPage(normalizedAiChatPage + 1)}
                        type="button"
                      >
                        {t("ai.older")}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  <div className="ai-chat-open-head">
                    <button
                      className="icon-button"
                      onClick={() => {
                        setAiChatMode("list");
                        setAiProposal(undefined);
                      }}
                      title={t("ai.backToChats")}
                      type="button"
                    >
                      <ArrowLeft size={16} />
                    </button>
                    <div>
                      <strong>{activeAiChat?.title ?? t("ai.newChat")}</strong>
                      <span>{activeAiChat ? `${activeAiChat.messages.length} ${t("common.messages")}` : t("common.noMessages")}</span>
                    </div>
                    {activeAiChat ? (
                      <button
                        className="icon-button ai-chat-archive"
                        onClick={() => archiveAiChat(activeAiChat.id)}
                        title={t("ai.archiveChat")}
                        type="button"
                      >
                        <Archive size={14} />
                      </button>
                    ) : null}
                  </div>
                  <div className={`ai-messages ${aiProposal ? "ai-messages-with-proposal" : ""}`}>
                    {aiMessages.length ? (
                      aiMessages.map((message) => (
                        <div className={`ai-message ai-message-${message.role}`} key={message.id}>
                          {message.content}
                        </div>
                      ))
                    ) : (
                      <div className="ai-empty">
                        {t("ai.emptyPrompt")}
                      </div>
                    )}
                  </div>
                  {aiProposal ? (
                    <div className="ai-proposal">
                      <div className="ai-proposal-head">
                        <strong>{t("ai.pendingProposal")}</strong>
                        <span>{aiProposal.changes.length} {t("common.changes")}</span>
                      </div>
                      {aiProposal.warnings?.length ? (
                        <div className="ai-warnings">
                          {aiProposal.warnings.map((warning) => (
                            <span key={warning}>
                              <AlertTriangle size={13} />
                              {warning}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="ai-change-list">
                        {aiProposal.changes.map((change, index) => (
                          <div
                            className={`ai-change-item ${isDestructiveAiChange(change) ? "ai-change-item-danger" : ""}`}
                            key={`${change.type}-${index}`}
                          >
                            <span>{isDestructiveAiChange(change) ? t("ai.destructive") : t("ai.change")}</span>
                            {describeAiChangeText(change, project, t)}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {aiProposal ? (
                    <div className="ai-proposal-actions">
                      <button className="button secondary" onClick={cancelAiProposal} type="button">
                        {t("common.cancel")}
                      </button>
                      <button className="button primary" onClick={applyAiProposal} type="button">
                        <Check size={16} />
                        {t("ai.applyChanges")}
                      </button>
                    </div>
                  ) : (
                    <form
                      className="ai-input"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void sendAiMessage();
                      }}
                    >
                      <textarea
                        disabled={aiBusy}
                        placeholder={t("ai.inputPlaceholder")}
                        value={aiInput}
                        onChange={(event) => setAiInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            void sendAiMessage();
                          }
                        }}
                      />
                      <button className="button primary" disabled={aiBusy || !aiInput.trim()} type="submit">
                        {aiBusy ? <Loader2 className="spin" size={16} /> : <SendHorizontal size={16} />}
                        {t("ai.send")}
                      </button>
                    </form>
                  )}
                </>
              )}
            </aside>
          ) : null}
        </div>

        {migration ? (
          <footer
            className={`migration-panel ${migrationCollapsed ? "migration-panel-collapsed" : ""}`}
            style={{ "--migration-panel-height": `${migrationPanelHeight}px` } as CSSProperties}
          >
            {!migrationCollapsed ? (
              <button
                aria-label={t("migration.resize")}
                className="migration-resize-handle"
                onMouseDown={(event) => {
                  event.preventDefault();
                  setMigrationResize({ startY: event.clientY, startHeight: migrationPanelHeight });
                }}
                title={t("migration.resize")}
                type="button"
              />
            ) : null}
            <div className="migration-head">
              <div>
                <h2>{t("migration.title")}</h2>
                <p>{t("migration.detected", { count: migration.summary.items.length })}</p>
              </div>
              <div className="row">
                {userMigrations[0] ? <span className="timestamp">{t("migration.latest", { date: new Date(userMigrations[0].createdAt).toLocaleString() })}</span> : null}
                <button className="icon-button" onClick={() => setMigrationCollapsed((value) => !value)} title={migrationCollapsed ? t("migration.showSql") : t("migration.hideSql")} type="button">
                  {migrationCollapsed ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <button className="button secondary" onClick={downloadMigration} type="button">
                  <Download size={16} />
                  SQL
                </button>
                <button
                  className="icon-button"
                  onClick={() => {
                    setMigration(undefined);
                    setMigrationCollapsed(false);
                  }}
                  title={t("common.close")}
                  type="button"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            {!migrationCollapsed ? (
              <>
                {migration.warnings.length ? (
                  <div className="warnings">
                    {migration.warnings.map((warning) => (
                      <span key={warning}>
                        <AlertTriangle size={14} />
                        {warning}
                      </span>
                    ))}
                  </div>
                ) : null}
                <pre>{renderSql(migration.sql)}</pre>
              </>
            ) : null}
          </footer>
        ) : null}
      </section>

      {describedMigration ? (
        <div className="modal-backdrop">
          <section className="modal migration-description-modal">
            <header>
              <div>
                <h2>{t("migration.aiDescription")}</h2>
                <p className="muted">
                  {describedMigration.name} · {new Date(describedMigration.createdAt).toLocaleString()}
                </p>
              </div>
              <button className="icon-button" onClick={() => setMigrationDescriptionId(undefined)} title={t("common.close")} type="button">
                <X size={16} />
              </button>
            </header>
            {describedMigrationStats ? (
              <div className="migration-review-badges">
                <span className={`migration-risk-badge migration-risk-${describedMigrationStats.risk}`}>
                  {t("migration.globalRisk")}: {migrationRiskLabel(describedMigrationStats.risk, t)}
                </span>
                <span>{t("migration.affectedTablesBadge", { count: describedMigrationStats.affectedTablesCount })}</span>
                <span>{t("migration.relationshipChangesBadge", { count: describedMigrationStats.relationshipChangesCount })}</span>
                <span className={describedMigrationStats.destructiveChangesCount ? "migration-risk-badge migration-risk-high" : ""}>
                  {t("migration.destructiveChangesBadge", { count: describedMigrationStats.destructiveChangesCount })}
                </span>
              </div>
            ) : null}
            <div className="migration-description-body">
              {describingMigrationId === describedMigration.id && !describedMigration.aiDescription ? (
                <div className="project-browser-empty migration-description-loading">
                  <Loader2 className="spin" size={24} />
                  <h2>{t("migration.aiDescriptionGenerating")}</h2>
                  <p>{t("migration.aiDescriptionGeneratingBody")}</p>
                </div>
              ) : (
                renderMarkdown(localizeMigrationMarkdown(describedMigration.aiDescription ?? t("migration.aiDescriptionUnavailable"), activeLocale))
              )}
            </div>
            <div className="modal-actions">
              <button className="button secondary" onClick={() => void copyMigrationDescriptionText(describedMigration)} disabled={!describedMigration.aiDescription} type="button">
                <CopyPlus size={16} />
                {migrationDescriptionCopied ? t("migration.copyDescriptionDone") : t("migration.copyDescription")}
              </button>
              <button
                className="button secondary"
                onClick={() => {
                  showMigrationInConsole(describedMigration);
                  setMigrationDescriptionId(undefined);
                }}
                type="button"
              >
                <FileCode2 size={16} />
                {t("migration.viewSql")}
              </button>
              <button className="button primary" onClick={() => setMigrationDescriptionId(undefined)} type="button">
                {t("common.close")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {error ? (
        <div className="modal-backdrop modal-backdrop-alert">
          <section className="modal confirm-modal error-modal">
            <header>
              <h2>{t("common.warning")}</h2>
              <button className="icon-button" onClick={() => setError(undefined)} type="button">
                x
              </button>
            </header>
            <div className="confirm-body">
              <div className="confirm-icon warning">
                <AlertTriangle size={22} />
              </div>
              <div>
                <h3>{t("error.title")}</h3>
                <p>{error}</p>
              </div>
            </div>
            <div className="modal-actions">
              <button className="button primary" onClick={() => setError(undefined)} type="button">
                {t("common.understood")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {shareProjectTarget ? (
        <div className="modal-backdrop">
          <section className="modal confirm-modal">
            <header>
              <h2>{t("project.shareTitle")}</h2>
              <button
                className="icon-button"
                onClick={() => {
                  setShareProjectId(undefined);
                  setShareProjectEmail("");
                }}
                type="button"
              >
                x
              </button>
            </header>
            <div className="confirm-body">
              <div className="confirm-icon">
                <UserPlus size={22} />
              </div>
              <div className="confirm-content">
                <h3>{shareProjectTarget.name}</h3>
                <p>{t("project.shareBody")}</p>
                <label className="modal-field">
                  {t("project.shareEmail")}
                  <input
                    autoFocus
                    placeholder={t("project.shareEmailPlaceholder")}
                    type="email"
                    value={shareProjectEmail}
                    onChange={(event) => setShareProjectEmail(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && shareProjectEmail.trim()) {
                        event.preventDefault();
                        void shareProjectWithUser();
                      }
                    }}
                  />
                </label>
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="button secondary"
                onClick={() => {
                  setShareProjectId(undefined);
                  setShareProjectEmail("");
                }}
                type="button"
              >
                {t("common.cancel")}
              </button>
              <button className="button primary" disabled={sharingProject || !shareProjectEmail.trim()} onClick={shareProjectWithUser} type="button">
                {sharingProject ? <Loader2 className="spin" size={16} /> : <UserPlus size={16} />}
                {t("project.shareConfirm")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingDeleteProject ? (
        <div className="modal-backdrop">
          <section className="modal confirm-modal">
            <header>
              <h2>{pendingDeleteProjectIsOwner ? t("delete.projectTitle") : t("delete.projectUnlinkTitle")}</h2>
              <button className="icon-button" onClick={() => setPendingDeleteProjectId(undefined)} type="button">
                x
              </button>
            </header>
            <div className="confirm-body">
              <div className={pendingDeleteProjectIsOwner ? "confirm-icon danger" : "confirm-icon warning"}>
                {pendingDeleteProjectIsOwner ? <Trash2 size={22} /> : <AlertTriangle size={22} />}
              </div>
              <div>
                <h3>{pendingDeleteProject.name}</h3>
                <p>{pendingDeleteProjectIsOwner ? t("delete.projectBody") : t("delete.projectUnlinkBody")}</p>
              </div>
            </div>
            <div className="modal-actions">
              <button className="button secondary" disabled={deletingProject} onClick={() => setPendingDeleteProjectId(undefined)} type="button">
                {t("common.cancel")}
              </button>
              <button className={pendingDeleteProjectIsOwner ? "button danger" : "button primary"} disabled={deletingProject} onClick={deleteOrUnlinkProject} type="button">
                {deletingProject ? <Loader2 className="spin" size={16} /> : pendingDeleteProjectIsOwner ? <Trash2 size={16} /> : <X size={16} />}
                {pendingDeleteProjectIsOwner ? t("delete.confirmProject") : t("delete.confirmProjectUnlink")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {createProjectOpen ? (
        <div className="modal-backdrop">
          <section className="modal confirm-modal">
            <header>
              <h2>{t("project.createTitle")}</h2>
              <button
                className="icon-button"
                onClick={() => {
                  setCreateProjectOpen(false);
                  setCreateProjectName("");
                }}
                type="button"
              >
                x
              </button>
            </header>
            <div className="confirm-body">
              <div className="confirm-icon">
                <FolderPlus size={22} />
              </div>
              <div className="confirm-content">
                <h3>{t("project.createWorkspaceTitle")}</h3>
                <p>{t("project.createWorkspaceBody")}</p>
                <label className="modal-field">
                  {t("project.name")}
                  <input
                    autoFocus
                    placeholder={t("project.namePlaceholder")}
                    value={createProjectName}
                    onChange={(event) => setCreateProjectName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void createProject();
                      }
                    }}
                  />
                  {createProjectName.trim() && projectNameExists(createProjectName) ? (
                    <small className="field-error">{t("project.nameExists")}</small>
                  ) : null}
                </label>
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="button secondary"
                onClick={() => {
                  setCreateProjectOpen(false);
                  setCreateProjectName("");
                }}
                type="button"
              >
                {t("common.cancel")}
              </button>
              <button
                className="button primary"
                disabled={creatingProject || createProjectNameInvalid}
                onClick={createProject}
                type="button"
              >
                {creatingProject ? <Loader2 className="spin" size={16} /> : <FolderPlus size={16} />}
                {t("project.create")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {copyProjectOpen && project ? (
        <div className="modal-backdrop">
          <section className="modal confirm-modal">
            <header>
              <h2>{t("project.copyTitle")}</h2>
              <button
                className="icon-button"
                onClick={() => {
                  setCopyProjectOpen(false);
                  setCopyProjectName("");
                }}
                type="button"
              >
                x
              </button>
            </header>
            <div className="confirm-body">
              <div className="confirm-icon">
                <CopyPlus size={22} />
              </div>
              <div className="confirm-content">
                <h3>{t("project.copyWorkspaceTitle")}</h3>
                <p>{t("project.copyWorkspaceBody", { project: project.name })}</p>
                <label className="modal-field">
                  {t("project.copyName")}
                  <input
                    autoFocus
                    placeholder={t("project.namePlaceholder")}
                    value={copyProjectName}
                    onChange={(event) => setCopyProjectName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !copyProjectNameInvalid) {
                        event.preventDefault();
                        void duplicateProject();
                      }
                    }}
                  />
                  {copyProjectName.trim() && projectNameExists(copyProjectName) ? (
                    <small className="field-error">{t("project.nameExists")}</small>
                  ) : null}
                </label>
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="button secondary"
                onClick={() => {
                  setCopyProjectOpen(false);
                  setCopyProjectName("");
                }}
                type="button"
              >
                {t("common.cancel")}
              </button>
              <button className="button primary" disabled={copyingProject || copyProjectNameInvalid} onClick={duplicateProject} type="button">
                {copyingProject ? <Loader2 className="spin" size={16} /> : <CopyPlus size={16} />}
                {t("project.copySave")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {projectContextOpen ? (
        <div className="modal-backdrop">
          <section className="modal ai-context-modal">
            <header>
              <div>
                <h2>{t("project.aiContextTitle")}</h2>
                <p className="muted">{t("project.aiContextBody")}</p>
              </div>
              <button
                className="icon-button"
                onClick={() => {
                  setProjectContextOpen(false);
                  setProjectContextProjectId(undefined);
                  setProjectContextDraft("");
                }}
                type="button"
              >
                x
              </button>
            </header>
            <div className="ai-context-box">
              <div className="confirm-icon">
                <Info size={22} />
              </div>
              <label>
                {t("project.aiContextLabel")}
                <textarea
                  autoFocus
                  maxLength={PROJECT_AI_CONTEXT_MAX_LENGTH}
                  placeholder={t("project.aiContextPlaceholder")}
                  value={projectContextDraft}
                  onChange={(event) => setProjectContextDraft(event.target.value)}
                />
                <small className="muted">{t("project.aiContextLimit", { count: PROJECT_AI_CONTEXT_MAX_LENGTH })}</small>
              </label>
            </div>
            <div className="modal-actions">
              <span className="muted">{projectContextDraft.length.toLocaleString()} / {PROJECT_AI_CONTEXT_MAX_LENGTH.toLocaleString()} {t("common.characters")}</span>
              <button
                className="button secondary"
                onClick={() => {
                  setProjectContextOpen(false);
                  setProjectContextProjectId(undefined);
                  setProjectContextDraft("");
                }}
                type="button"
              >
                {t("common.cancel")}
              </button>
              <button className="button primary" disabled={projectContextSaving} onClick={saveProjectContext} type="button">
                {projectContextSaving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                {t("project.saveContext")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {createViewOpen ? (
        <div className="modal-backdrop">
          <section className="modal confirm-modal">
            <header>
              <h2>{t("view.createTitle")}</h2>
              <button
                className="icon-button"
                onClick={() => {
                  setCreateViewOpen(false);
                  setCreateViewName("");
                }}
                type="button"
              >
                x
              </button>
            </header>
            <div className="confirm-body">
              <div className="confirm-icon">
                <Table2 size={22} />
              </div>
              <div className="confirm-content">
                <h3>{t("view.createCanvasTitle")}</h3>
                <p>{t("view.createCanvasBody")}</p>
                <label className="modal-field">
                  {t("view.name")}
                  <input
                    autoFocus
                    placeholder={t("view.namePlaceholder")}
                    value={createViewName}
                    onChange={(event) => setCreateViewName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        createView();
                      }
                    }}
                  />
                </label>
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="button secondary"
                onClick={() => {
                  setCreateViewOpen(false);
                  setCreateViewName("");
                }}
                type="button"
              >
                {t("common.cancel")}
              </button>
              <button className="button primary" disabled={!project} onClick={createView} type="button">
                <Plus size={16} />
                {t("view.create")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingDeleteViewId && project && pendingDeleteView ? (
        <div className="modal-backdrop">
          <section className="modal confirm-modal">
            <header>
              <h2>{t("delete.viewTitle")}</h2>
              <button className="icon-button" onClick={() => setPendingDeleteViewId(undefined)} type="button">
                x
              </button>
            </header>
            <div className="confirm-body">
              <div className="confirm-icon danger">
                <Trash2 size={22} />
              </div>
              <div>
                <h3>{pendingDeleteView.name}</h3>
                <p>{t("delete.viewBody")}</p>
              </div>
            </div>
            <div className="modal-actions">
              <button className="button secondary" onClick={() => setPendingDeleteViewId(undefined)} type="button">
                {t("common.cancel")}
              </button>
              <button className="button danger" onClick={() => deleteView(pendingDeleteViewId)} type="button">
                <Trash2 size={16} />
                {t("delete.confirmView")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingDeleteTableId && project ? (
        <div className="modal-backdrop">
          <section className="modal confirm-modal">
            <header>
              <h2>{t("delete.tableTitle")}</h2>
              <button className="icon-button" onClick={() => setPendingDeleteTableId(undefined)} type="button">
                x
              </button>
            </header>
            <div className="confirm-body">
              <div className="confirm-icon danger">
                <Trash2 size={22} />
              </div>
              <div>
                <h3>{findTable(project.model, pendingDeleteTableId)?.name ?? t("common.tableFallback")}</h3>
                <p>{t("delete.tableBody")}</p>
              </div>
            </div>
            <div className="modal-actions">
              <button className="button secondary" onClick={() => setPendingDeleteTableId(undefined)} type="button">
                {t("common.cancel")}
              </button>
              <button className="button danger" onClick={() => deleteTable(pendingDeleteTableId)} type="button">
                <Trash2 size={16} />
                {t("delete.confirmTable")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingDeleteRelationId && project && pendingDeleteRelation ? (
        <div className="modal-backdrop">
          <section className="modal confirm-modal">
            <header>
              <h2>{t("delete.relationTitle")}</h2>
              <button className="icon-button" onClick={() => setPendingDeleteRelationId(undefined)} type="button">
                x
              </button>
            </header>
            <div className="confirm-body">
              <div className="confirm-icon danger">
                <Trash2 size={22} />
              </div>
              <div>
                <h3>{relationLabelFromIndexes(pendingDeleteRelation, projectTablesById, projectColumnsByKey, t)}</h3>
                <p>{t("delete.relationBody")}</p>
              </div>
            </div>
            <div className="modal-actions">
              <button className="button secondary" onClick={() => setPendingDeleteRelationId(undefined)} type="button">
                {t("common.cancel")}
              </button>
              <button className="button danger" onClick={() => deleteRelation(pendingDeleteRelationId)} type="button">
                <Trash2 size={16} />
                {t("delete.confirmRelation")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingProjectAction ? (
        <div className="modal-backdrop modal-backdrop-alert">
          <section className="modal confirm-modal">
            <header>
              <h2>{t("project.unsavedSwitchTitle")}</h2>
              <button className="icon-button" onClick={() => setPendingProjectAction(undefined)} type="button">
                x
              </button>
            </header>
            <div className="confirm-body">
              <div className="confirm-icon warning">
                <AlertTriangle size={22} />
              </div>
              <div>
                <h3>{t("migration.unsavedTitle")}</h3>
                <p>{t("project.unsavedSwitchBody")}</p>
              </div>
            </div>
            <div className="modal-actions modal-actions-split">
              <button className="button secondary" disabled={saving} onClick={continueProjectActionWithoutSaving} type="button">
                {t("project.continueWithoutSaving")}
              </button>
              <span />
              <button className="button secondary" disabled={saving} onClick={() => setPendingProjectAction(undefined)} type="button">
                {t("common.cancel")}
              </button>
              <button className="button primary" disabled={saving} onClick={saveAndContinueProjectAction} type="button">
                {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                {t("project.saveAndContinue")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {saveBeforeMigrationOpen ? (
        <div className="modal-backdrop">
          <section className="modal confirm-modal">
            <header>
              <h2>{t("migration.saveBeforeTitle")}</h2>
              <button className="icon-button" onClick={() => setSaveBeforeMigrationOpen(false)} type="button">
                x
              </button>
            </header>
            <div className="confirm-body">
              <div className="confirm-icon">
                <Save size={22} />
              </div>
              <div>
                <h3>{t("migration.unsavedTitle")}</h3>
                <p>{t("migration.unsavedBody")}</p>
              </div>
            </div>
            <div className="modal-actions">
              <button className="button secondary" onClick={() => setSaveBeforeMigrationOpen(false)} type="button">
                {t("common.cancel")}
              </button>
              <button className="button primary" disabled={saving || generating} onClick={saveAndGenerateSql} type="button">
                {saving || generating ? <Loader2 className="spin" size={16} /> : <FileCode2 size={16} />}
                {t("migration.saveAndGenerate")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {importOpen ? (
        <div className="modal-backdrop">
          <section className={`modal ${importPreview ? "import-review-modal" : ""}`}>
            {importPreview ? (
              <>
                <header>
                  <div>
                    <h2>{t("import.reviewTitle")}</h2>
                    <p className="muted">{t("import.reviewBody")}</p>
                  </div>
                  <button className="icon-button" onClick={() => setImportOpen(false)} type="button">
                    x
                  </button>
                </header>
                <div className="import-review-toolbar">
                  <div>
                    <strong>{importPreview.filter((table) => table.selected).length}</strong>
                    <span>{t("import.selectedOf", { count: importPreview.length })}</span>
                  </div>
                  <div className="import-preview-actions">
                    <button
                      className="button secondary"
                      onClick={() => setImportPreview((tables) => tables?.map((table) => ({ ...table, selected: true })))}
                      type="button"
                    >
                      {t("import.all")}
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => setImportPreview((tables) => tables?.map((table) => ({ ...table, selected: false })))}
                      type="button"
                    >
                      {t("import.none")}
                    </button>
                  </div>
                </div>
                <div className="import-review-grid">
                  <div className="import-review-grid-head">
                    <span>{t("import.model")}</span>
                    <span>{t("import.action")}</span>
                    <span>{t("import.origin")}</span>
                    <span>{t("import.fields")}</span>
                  </div>
                  <div className="import-review-list">
                    {importPreview.map((table) => (
                      <label className="import-review-row" key={table.key}>
                        <span className="import-review-model-cell">
                          <input
                            checked={table.selected}
                            onChange={(event) =>
                              setImportPreview((tables) =>
                                tables?.map((item) =>
                                  item.key === table.key ? { ...item, selected: event.target.checked } : item,
                                ),
                              )
                            }
                            type="checkbox"
                          />
                          <Table2 size={15} />
                          <strong>{table.name}</strong>
                        </span>
                        <span className="import-review-action-cell">
                          <span className={`import-preview-status import-preview-status-${table.status}`}>
                            {table.status === "new" ? t("import.statusNew") : table.status === "changed" ? t("import.statusChanged") : t("import.statusUnchanged")}
                          </span>
                          <span className={`import-review-action ${table.selected ? "import-review-action-active" : ""}`}>
                            {table.selected ? t("import.updateModel") : t("import.ignore")}
                          </span>
                        </span>
                        <span className="import-review-source-cell">{table.schema}</span>
                        <span className="import-review-count-cell">{table.columns}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="modal-actions import-review-footer">
                  <button className="button secondary" onClick={() => setImportPreview(undefined)} type="button">
                    {t("import.back")}
                  </button>
                  <button
                    className="button primary"
                    disabled={importing || importPreview.every((table) => !table.selected)}
                    onClick={applyImportSchema}
                    type="button"
                  >
                    {importing ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                    {t("common.continue")}
                  </button>
                </div>
              </>
            ) : (
              <>
            <header>
              <h2>{t("import.title")}</h2>
              <button className="icon-button" onClick={() => setImportOpen(false)} type="button">
                x
              </button>
            </header>
            <p className="muted">
              {t("import.body")}
            </p>
            <label>
              {t("import.supabaseUrl")}
              <input
                value={importForm.supabaseUrl}
                onChange={(event) => setImportForm({ ...importForm, supabaseUrl: event.target.value })}
              />
            </label>
            <label>
              {t("import.connectionString")}
              <input
                placeholder="postgresql://..."
                value={importForm.connectionString}
                onChange={(event) => setImportForm({ ...importForm, connectionString: event.target.value })}
              />
            </label>
            <div className="form-grid">
              <label>
                {t("import.host")}
                <input value={importForm.host} onChange={(event) => setImportForm({ ...importForm, host: event.target.value })} />
              </label>
              <label>
                {t("import.port")}
                <input value={importForm.port} onChange={(event) => setImportForm({ ...importForm, port: event.target.value })} />
              </label>
              <label>
                {t("import.database")}
                <input value={importForm.database} onChange={(event) => setImportForm({ ...importForm, database: event.target.value })} />
              </label>
              <label>
                {t("import.username")}
                <input value={importForm.username} onChange={(event) => setImportForm({ ...importForm, username: event.target.value })} />
              </label>
            </div>
            <div className="form-grid">
              <label>
                {t("import.password")}
                <input
                  type="password"
                  value={importForm.password}
                  onChange={(event) => setImportForm({ ...importForm, password: event.target.value })}
                />
              </label>
              <label>
                {t("import.schema")}
                <input value={importForm.schema} onChange={(event) => setImportForm({ ...importForm, schema: event.target.value })} />
              </label>
            </div>
            <label className="pretty-check">
              <input
                checked={importForm.ssl}
                onChange={(event) => setImportForm({ ...importForm, ssl: event.target.checked })}
                type="checkbox"
              />
              <span className="pretty-check-mark" />
              <span>{t("import.ssl")}</span>
            </label>
            <label className="pretty-check import-save-check">
              <input
                checked={importForm.saveConnectionSettings}
                onChange={(event) =>
                  setImportForm({ ...importForm, saveConnectionSettings: event.target.checked })
                }
                type="checkbox"
              />
              <span className="pretty-check-mark" />
              <span>
                {t("import.saveSettings")}
                <small>{t("import.saveSettingsHelp")}</small>
              </span>
            </label>
            <div className="modal-actions">
              <button className="button secondary" onClick={() => setImportOpen(false)} type="button">
                {t("common.cancel")}
              </button>
              <button className="button primary" disabled={importing} onClick={previewImportSchema} type="button">
                {importing ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                {t("import.analyze")}
              </button>
            </div>
              </>
            )}
          </section>
        </div>
      ) : null}
    </main>
  );
}
