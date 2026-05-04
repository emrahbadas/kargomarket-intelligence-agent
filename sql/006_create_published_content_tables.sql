create table if not exists public.published_sector_news (
  id uuid primary key,
  review_queue_id uuid not null unique references public.content_review_queue(id) on delete cascade,
  parsed_signal_id uuid not null references public.content_parse_results(id) on delete cascade,
  raw_ingest_id uuid not null references public.raw_content_ingest(id) on delete cascade,
  publish_target text not null check (publish_target = 'sector-news'),
  title text not null,
  summary text not null,
  impact_summary text not null,
  category text not null,
  confidence numeric(5,4) not null,
  source_name text not null,
  source_url text null,
  facts jsonb not null default '{}'::jsonb,
  reviewer_notes text null,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_published_sector_news_published_at
  on public.published_sector_news(published_at desc);

create index if not exists idx_published_sector_news_category_published_at
  on public.published_sector_news(category, published_at desc);

create table if not exists public.published_market_signals (
  id uuid primary key,
  review_queue_id uuid not null unique references public.content_review_queue(id) on delete cascade,
  parsed_signal_id uuid not null references public.content_parse_results(id) on delete cascade,
  raw_ingest_id uuid not null references public.raw_content_ingest(id) on delete cascade,
  publish_target text not null check (publish_target = 'market-signal'),
  title text not null,
  summary text not null,
  impact_summary text not null,
  category text not null,
  confidence numeric(5,4) not null,
  source_name text not null,
  source_url text null,
  facts jsonb not null default '{}'::jsonb,
  reviewer_notes text null,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_published_market_signals_published_at
  on public.published_market_signals(published_at desc);

create index if not exists idx_published_market_signals_category_published_at
  on public.published_market_signals(category, published_at desc);

create or replace function public.set_published_content_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_published_sector_news_updated_at on public.published_sector_news;

create trigger trg_published_sector_news_updated_at
before update on public.published_sector_news
for each row
execute function public.set_published_content_updated_at();

drop trigger if exists trg_published_market_signals_updated_at on public.published_market_signals;

create trigger trg_published_market_signals_updated_at
before update on public.published_market_signals
for each row
execute function public.set_published_content_updated_at();

alter table public.published_sector_news enable row level security;
alter table public.published_market_signals enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'published_sector_news'
      and policyname = 'service_role_full_access_on_published_sector_news'
  ) then
    create policy service_role_full_access_on_published_sector_news
      on public.published_sector_news
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'published_market_signals'
      and policyname = 'service_role_full_access_on_published_market_signals'
  ) then
    create policy service_role_full_access_on_published_market_signals
      on public.published_market_signals
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end;
$$;