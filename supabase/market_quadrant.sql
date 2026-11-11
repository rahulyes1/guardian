-- Shared daily Market Quadrant result (QUAD tab).
-- The first visitor after the 15:45 IST close computes the Nifty 500 breadth in the
-- browser and saves it here; everyone else loads it instantly instead of downloading
-- 500 stocks. Safe to run more than once.

create table if not exists public.market_quadrant (
  as_of       date primary key,               -- last trading day in the data
  data        jsonb not null,                 -- full result object from marketQuadrant.js
  computed_at timestamptz not null default now(),
  constraint market_quadrant_shape check (
    jsonb_typeof(data) = 'object'
    and data ->> 'overall' in ('INVEST', 'SELECTIVE', 'CASH')
    and jsonb_typeof(data -> 'history') = 'array'
    and pg_column_size(data) < 200000
  )
);

alter table public.market_quadrant enable row level security;

grant select on table public.market_quadrant to anon, authenticated;
grant insert, update on table public.market_quadrant to authenticated;

drop policy if exists market_quadrant_read on public.market_quadrant;
create policy market_quadrant_read
on public.market_quadrant
for select
using (true);

-- Any signed-in session (the app signs visitors in anonymously) may write.
-- Results are market-wide, not per user.
drop policy if exists market_quadrant_insert on public.market_quadrant;
create policy market_quadrant_insert
on public.market_quadrant
for insert to authenticated
with check (true);

drop policy if exists market_quadrant_update on public.market_quadrant;
create policy market_quadrant_update
on public.market_quadrant
for update to authenticated
using (true)
with check (true);
