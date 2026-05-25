-- DBOpenStudio initial Supabase schema.
--
-- This file is the clean public OSS install baseline. It contains the complete
-- app persistence schema required by a fresh DBOpenStudio deployment.

create extension if not exists pgcrypto;

create table if not exists public.dbos_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  email text,
  locale text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dbos_profiles_locale_check check (locale in ('en', 'es', 'ca'))
);

alter table public.dbos_profiles
  add column if not exists locale text not null default 'en';

update public.dbos_profiles
set locale = 'en'
where locale not in ('en', 'es', 'ca');

alter table public.dbos_profiles
  drop constraint if exists dbos_profiles_locale_check;

alter table public.dbos_profiles
  add constraint dbos_profiles_locale_check check (locale in ('en', 'es', 'ca'));

create table if not exists public.dbos_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  ai_context text,
  active_view_id text,
  model_revision integer not null default 1,
  layout_revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dbos_project_connections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.dbos_projects(id) on delete cascade,
  provider text not null check (provider in ('supabase', 'postgres')),
  name text not null,
  public_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dbos_project_members (
  project_id uuid not null references public.dbos_projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('editor')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table if not exists public.dbos_schema_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.dbos_projects(id) on delete cascade,
  source_connection_id uuid references public.dbos_project_connections(id) on delete set null,
  name text not null,
  schema_json jsonb not null,
  imported_at timestamptz not null default now()
);

create table if not exists public.dbos_visual_models (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.dbos_projects(id) on delete cascade,
  base_snapshot_id uuid references public.dbos_schema_snapshots(id) on delete set null,
  name text not null,
  model_json jsonb not null,
  canvas_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dbos_generated_migrations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.dbos_projects(id) on delete cascade,
  visual_model_id uuid references public.dbos_visual_models(id) on delete set null,
  from_snapshot_id uuid references public.dbos_schema_snapshots(id) on delete set null,
  generated_by_user_id uuid references auth.users(id) on delete set null,
  name text not null,
  sql text not null,
  warnings_json jsonb not null default '[]'::jsonb,
  diff_json jsonb not null default '{}'::jsonb,
  ai_description text,
  ai_description_generated_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'reviewed', 'applied', 'discarded')),
  created_at timestamptz not null default now()
);

create table if not exists public.dbos_project_model_tables (
  project_id uuid not null references public.dbos_projects(id) on delete cascade,
  table_id text not null,
  schema_name text not null,
  table_name text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, table_id)
);

create table if not exists public.dbos_project_model_columns (
  project_id uuid not null,
  table_id text not null,
  column_id text not null,
  column_name text not null,
  data_type text not null,
  nullable boolean not null default true,
  primary_key boolean not null default false,
  is_unique boolean not null default false,
  default_value text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, table_id, column_id),
  foreign key (project_id, table_id)
    references public.dbos_project_model_tables(project_id, table_id)
    on delete cascade
);

create table if not exists public.dbos_project_model_indexes (
  project_id uuid not null,
  table_id text not null,
  index_id text not null,
  index_name text not null,
  columns_json jsonb not null default '[]'::jsonb,
  is_unique boolean not null default false,
  definition text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, table_id, index_id),
  foreign key (project_id, table_id)
    references public.dbos_project_model_tables(project_id, table_id)
    on delete cascade
);

create table if not exists public.dbos_project_model_relations (
  project_id uuid not null references public.dbos_projects(id) on delete cascade,
  relation_id text not null,
  relation_name text not null,
  cardinality text check (cardinality in ('one-to-many', 'one-to-one')),
  identifying boolean,
  from_table_id text not null,
  from_column_id text not null,
  to_table_id text not null,
  to_column_id text not null,
  on_delete text,
  on_update text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, relation_id)
);

create table if not exists public.dbos_project_canvas_views (
  project_id uuid not null references public.dbos_projects(id) on delete cascade,
  view_id text not null,
  name text not null,
  is_primary boolean not null default false,
  viewport_json jsonb not null default '{"x":0,"y":0,"zoom":1}'::jsonb,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, view_id)
);

create table if not exists public.dbos_project_canvas_nodes (
  project_id uuid not null,
  view_id text not null,
  table_id text not null,
  x numeric not null default 0,
  y numeric not null default 0,
  width numeric,
  height numeric,
  collapsed boolean,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, view_id, table_id),
  foreign key (project_id, view_id)
    references public.dbos_project_canvas_views(project_id, view_id)
    on delete cascade
);

create index if not exists dbos_projects_user_id_idx
  on public.dbos_projects(user_id);

create unique index if not exists dbos_project_connections_project_id_key
  on public.dbos_project_connections(project_id);

create index if not exists dbos_connections_project_id_idx
  on public.dbos_project_connections(project_id);

create index if not exists dbos_project_members_user_id_idx
  on public.dbos_project_members(user_id);

create index if not exists dbos_snapshots_project_id_idx
  on public.dbos_schema_snapshots(project_id);

create index if not exists dbos_models_project_id_idx
  on public.dbos_visual_models(project_id);

create index if not exists dbos_migrations_project_id_idx
  on public.dbos_generated_migrations(project_id);

create index if not exists dbos_model_tables_project_idx
  on public.dbos_project_model_tables(project_id);

create index if not exists dbos_model_columns_project_table_idx
  on public.dbos_project_model_columns(project_id, table_id);

create index if not exists dbos_model_relations_project_idx
  on public.dbos_project_model_relations(project_id);

create index if not exists dbos_canvas_views_project_idx
  on public.dbos_project_canvas_views(project_id);

create index if not exists dbos_canvas_nodes_project_view_idx
  on public.dbos_project_canvas_nodes(project_id, view_id);

create or replace function public.dbos_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.dbos_profiles (id, display_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), 'User'),
    new.email
  )
  on conflict (id) do update
    set display_name = excluded.display_name,
        email = coalesce(excluded.email, public.dbos_profiles.email),
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists dbos_on_auth_user_created on auth.users;
create trigger dbos_on_auth_user_created
  after insert on auth.users
  for each row execute function public.dbos_handle_new_user();

create or replace function public.dbos_has_project_access(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.dbos_projects p
    where p.id = target_project_id
      and (
        p.user_id = auth.uid()
        or exists (
          select 1
          from public.dbos_project_members pm
          where pm.project_id = p.id
            and pm.user_id = auth.uid()
        )
      )
  );
$$;

create or replace function public.dbos_is_project_owner(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.dbos_projects p
    where p.id = target_project_id
      and p.user_id = auth.uid()
  );
$$;

revoke all on function public.dbos_has_project_access(uuid) from public;
revoke all on function public.dbos_is_project_owner(uuid) from public;
grant execute on function public.dbos_has_project_access(uuid) to authenticated;
grant execute on function public.dbos_is_project_owner(uuid) to authenticated;

alter table public.dbos_profiles enable row level security;
alter table public.dbos_projects enable row level security;
alter table public.dbos_project_connections enable row level security;
alter table public.dbos_project_members enable row level security;
alter table public.dbos_schema_snapshots enable row level security;
alter table public.dbos_visual_models enable row level security;
alter table public.dbos_generated_migrations enable row level security;
alter table public.dbos_project_model_tables enable row level security;
alter table public.dbos_project_model_columns enable row level security;
alter table public.dbos_project_model_indexes enable row level security;
alter table public.dbos_project_model_relations enable row level security;
alter table public.dbos_project_canvas_views enable row level security;
alter table public.dbos_project_canvas_nodes enable row level security;

drop policy if exists "profiles_select_own" on public.dbos_profiles;
create policy "profiles_select_own"
  on public.dbos_profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.dbos_profiles;
create policy "profiles_insert_own"
  on public.dbos_profiles for insert
  with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.dbos_profiles;
create policy "profiles_update_own"
  on public.dbos_profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "projects_manage_own" on public.dbos_projects;
create policy "projects_manage_own"
  on public.dbos_projects for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "projects_select_shared" on public.dbos_projects;
create policy "projects_select_shared"
  on public.dbos_projects for select
  using (public.dbos_has_project_access(id));

drop policy if exists "project_members_select_accessible" on public.dbos_project_members;
create policy "project_members_select_accessible"
  on public.dbos_project_members for select
  using (public.dbos_has_project_access(project_id));

drop policy if exists "project_members_manage_owner" on public.dbos_project_members;
create policy "project_members_manage_owner"
  on public.dbos_project_members for all
  using (public.dbos_is_project_owner(project_id))
  with check (public.dbos_is_project_owner(project_id));

drop policy if exists "connections_manage_accessible_projects" on public.dbos_project_connections;
create policy "connections_manage_accessible_projects"
  on public.dbos_project_connections for all
  using (public.dbos_has_project_access(project_id))
  with check (public.dbos_has_project_access(project_id));

drop policy if exists "snapshots_manage_accessible_projects" on public.dbos_schema_snapshots;
create policy "snapshots_manage_accessible_projects"
  on public.dbos_schema_snapshots for all
  using (public.dbos_has_project_access(project_id))
  with check (public.dbos_has_project_access(project_id));

drop policy if exists "models_manage_accessible_projects" on public.dbos_visual_models;
create policy "models_manage_accessible_projects"
  on public.dbos_visual_models for all
  using (public.dbos_has_project_access(project_id))
  with check (public.dbos_has_project_access(project_id));

drop policy if exists "migrations_manage_accessible_projects" on public.dbos_generated_migrations;
create policy "migrations_manage_accessible_projects"
  on public.dbos_generated_migrations for all
  using (public.dbos_has_project_access(project_id))
  with check (public.dbos_has_project_access(project_id));

drop policy if exists "hybrid_tables_manage_accessible_projects" on public.dbos_project_model_tables;
create policy "hybrid_tables_manage_accessible_projects"
  on public.dbos_project_model_tables for all
  using (public.dbos_has_project_access(project_id))
  with check (public.dbos_has_project_access(project_id));

drop policy if exists "hybrid_columns_manage_accessible_projects" on public.dbos_project_model_columns;
create policy "hybrid_columns_manage_accessible_projects"
  on public.dbos_project_model_columns for all
  using (public.dbos_has_project_access(project_id))
  with check (public.dbos_has_project_access(project_id));

drop policy if exists "hybrid_indexes_manage_accessible_projects" on public.dbos_project_model_indexes;
create policy "hybrid_indexes_manage_accessible_projects"
  on public.dbos_project_model_indexes for all
  using (public.dbos_has_project_access(project_id))
  with check (public.dbos_has_project_access(project_id));

drop policy if exists "hybrid_relations_manage_accessible_projects" on public.dbos_project_model_relations;
create policy "hybrid_relations_manage_accessible_projects"
  on public.dbos_project_model_relations for all
  using (public.dbos_has_project_access(project_id))
  with check (public.dbos_has_project_access(project_id));

drop policy if exists "hybrid_views_manage_accessible_projects" on public.dbos_project_canvas_views;
create policy "hybrid_views_manage_accessible_projects"
  on public.dbos_project_canvas_views for all
  using (public.dbos_has_project_access(project_id))
  with check (public.dbos_has_project_access(project_id));

drop policy if exists "hybrid_nodes_manage_accessible_projects" on public.dbos_project_canvas_nodes;
create policy "hybrid_nodes_manage_accessible_projects"
  on public.dbos_project_canvas_nodes for all
  using (public.dbos_has_project_access(project_id))
  with check (public.dbos_has_project_access(project_id));
