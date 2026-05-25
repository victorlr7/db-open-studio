# Architecture Notes

This document gives contributors the technical context behind DBOpenStudio's
storage and large-schema design.

## Data Model

DBOpenStudio keeps the logical database model separate from visual canvas state.

- The logical model contains schemas, tables, columns, indexes and foreign keys.
- Canvas views contain visual organization only: visible tables, positions,
  sizes, collapsed state and viewport.
- Every project has one logical model and can have multiple canvas views.
- Project JSON export remains a portable import/export artifact, not the only
  runtime representation.

## Persistence

Local mode stores the workspace as JSON in `data/dbopenstudio.json`.

Supabase-backed mode stores DBOpenStudio-owned data under the `dbos_*` prefix.
Fresh installs apply the complete initial schema from `supabase/schema.sql`.

The Supabase schema stores project data in queryable records:

- projects and project members;
- saved source connection metadata;
- imported schema snapshots;
- logical model tables, columns, indexes and relations;
- per-view canvas layout;
- generated migrations and AI descriptions.

Source database credentials are not stored in project JSON or app persistence.
When the user chooses to save import settings, full credentials are encrypted in
browser local storage for that browser and project.

## Large Schemas

Large schemas should not require rewriting one ever-growing project document for
every interaction. The current architecture is moving toward focused reads and
writes:

- layout edits should affect layout rows only;
- model edits should affect only the changed tables, columns or relations;
- project lists should not need to hydrate full model and canvas data;
- exports should be generated on demand;
- AI requests should use compact context selected for the current task.

Implemented optimizations include:

- canvas rendering indexes visible nodes instead of scanning the whole model for
  every visible table;
- relationship candidates are calculated from the current view before building
  React Flow edges;
- table drag and resize state is kept transient during the interaction and
  committed once at the end;
- drag interactions do not add every mouse movement to undo history;
- React Flow edges stay structurally stable while nodes move, avoiding relation
  flicker during drag;
- project export JSON is generated only when requested.

## Technical Roadmap

These are contribution areas, not installation requirements:

- split project loading so the project list does not load model or canvas data;
- add layout-only save endpoints and model-operation endpoints;
- store undo/redo as bounded operations or patches;
- load table details and relationship candidates on demand for very large
  schemas;
- virtualize large sidebars, table lists and inspectors;
- add revision/conflict checks for shared editing;
- keep reducing writes to full JSON snapshots during normal model editing.

## Boundaries

DBOpenStudio generates SQL migrations but does not execute them. Users review
and run the generated SQL in their own migration workflow.

DBOpenStudio is not a general Postgres administration client. It focuses on
visual modeling, schema import, diffing and SQL generation.
