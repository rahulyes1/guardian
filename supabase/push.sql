-- Push notifications (alerts while the app is closed). Safe to run more than once.
-- Each signed-in device stores its Web Push subscription; the GitHub sender job reads them
-- with the service-role key (bypasses RLS) and records what it sent so nothing repeats.

create table if not exists public.push_subscriptions (
  endpoint     text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  subscription jsonb not null,
  created_at   timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
grant select, insert, update, delete on table public.push_subscriptions to authenticated;

drop policy if exists push_own_select on public.push_subscriptions;
create policy push_own_select on public.push_subscriptions for select to authenticated using (auth.uid() = user_id);
drop policy if exists push_own_insert on public.push_subscriptions;
create policy push_own_insert on public.push_subscriptions for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists push_own_update on public.push_subscriptions;
create policy push_own_update on public.push_subscriptions for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists push_own_delete on public.push_subscriptions;
create policy push_own_delete on public.push_subscriptions for delete to authenticated using (auth.uid() = user_id);

-- Alerts already sent (one per user, alert and day). Only the service role touches this.
create table if not exists public.push_sent (
  user_id uuid not null,
  alert   text not null,
  day     date not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, alert, day)
);
alter table public.push_sent enable row level security;
