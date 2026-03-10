create table if not exists public.app_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

grant select, insert, update, delete on table public.app_state to anon, authenticated;

drop policy if exists app_state_select_own on public.app_state;
create policy app_state_select_own
on public.app_state
for select
using (auth.uid() = user_id);

drop policy if exists app_state_insert_own on public.app_state;
create policy app_state_insert_own
on public.app_state
for insert
with check (auth.uid() = user_id);

drop policy if exists app_state_update_own on public.app_state;
create policy app_state_update_own
on public.app_state
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists app_state_delete_own on public.app_state;
create policy app_state_delete_own
on public.app_state
for delete
using (auth.uid() = user_id);

