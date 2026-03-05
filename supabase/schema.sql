create extension if not exists pgcrypto;

create table if not exists public.boxing_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  note text not null default '',
  issues jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint boxing_entries_user_date_unique unique (user_id, entry_date)
);

create table if not exists public.boxing_achieved_issues (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  issue_key text not null,
  created_at timestamptz not null default now(),
  constraint boxing_achieved_issues_user_key_unique unique (user_id, issue_key)
);

alter table public.boxing_entries enable row level security;
alter table public.boxing_achieved_issues enable row level security;

drop policy if exists "boxing_entries_select_own" on public.boxing_entries;
drop policy if exists "boxing_entries_insert_own" on public.boxing_entries;
drop policy if exists "boxing_entries_update_own" on public.boxing_entries;
drop policy if exists "boxing_entries_delete_own" on public.boxing_entries;

create policy "boxing_entries_select_own"
  on public.boxing_entries
  for select
  using (auth.uid() = user_id);

create policy "boxing_entries_insert_own"
  on public.boxing_entries
  for insert
  with check (auth.uid() = user_id);

create policy "boxing_entries_update_own"
  on public.boxing_entries
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "boxing_entries_delete_own"
  on public.boxing_entries
  for delete
  using (auth.uid() = user_id);

drop policy if exists "boxing_achieved_select_own" on public.boxing_achieved_issues;
drop policy if exists "boxing_achieved_insert_own" on public.boxing_achieved_issues;
drop policy if exists "boxing_achieved_delete_own" on public.boxing_achieved_issues;

create policy "boxing_achieved_select_own"
  on public.boxing_achieved_issues
  for select
  using (auth.uid() = user_id);

create policy "boxing_achieved_insert_own"
  on public.boxing_achieved_issues
  for insert
  with check (auth.uid() = user_id);

create policy "boxing_achieved_delete_own"
  on public.boxing_achieved_issues
  for delete
  using (auth.uid() = user_id);
