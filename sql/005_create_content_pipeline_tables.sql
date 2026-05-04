create table if not exists public.raw_content_ingest (
  id uuid primary key,
  source_id text not null,
  source_name text not null,
  title text not null,
  raw_text text not null,
  source_url text null,
  published_at timestamptz not null,
  checksum text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_raw_content_ingest_source_published_at
  on public.raw_content_ingest(source_id, published_at desc);

create index if not exists idx_raw_content_ingest_checksum
  on public.raw_content_ingest(checksum);

alter table public.raw_content_ingest enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'raw_content_ingest'
      and policyname = 'service_role_full_access_on_raw_content_ingest'
  ) then
    create policy service_role_full_access_on_raw_content_ingest
      on public.raw_content_ingest
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end;
$$;

create table if not exists public.content_parse_results (
  id uuid primary key,
  raw_ingest_id uuid not null references public.raw_content_ingest(id) on delete cascade,
  category text not null,
  title text not null,
  summary text not null,
  impact_summary text not null,
  confidence numeric(5,4) not null,
  facts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_content_parse_results_raw_ingest_id
  on public.content_parse_results(raw_ingest_id);

create index if not exists idx_content_parse_results_category_created_at
  on public.content_parse_results(category, created_at desc);

alter table public.content_parse_results enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'content_parse_results'
      and policyname = 'service_role_full_access_on_content_parse_results'
  ) then
    create policy service_role_full_access_on_content_parse_results
      on public.content_parse_results
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end;
$$;

create table if not exists public.content_review_queue (
  id uuid primary key,
  parsed_signal_id uuid not null references public.content_parse_results(id) on delete cascade,
  raw_ingest_id uuid not null references public.raw_content_ingest(id) on delete cascade,
  status text not null check (status in ('pending', 'approved', 'rejected', 'needs_edit', 'published')),
  publish_target text not null check (publish_target in ('sector-news', 'market-signal')),
  title text not null,
  summary text not null,
  impact_summary text not null,
  category text not null,
  confidence numeric(5,4) not null,
  source_name text not null,
  source_url text null,
  reviewer_notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_content_review_queue_status_created_at
  on public.content_review_queue(status, created_at desc);

create index if not exists idx_content_review_queue_publish_target_status
  on public.content_review_queue(publish_target, status, created_at desc);

create or replace function public.set_content_review_queue_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_content_review_queue_updated_at on public.content_review_queue;

create trigger trg_content_review_queue_updated_at
before update on public.content_review_queue
for each row
execute function public.set_content_review_queue_updated_at();

alter table public.content_review_queue enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'content_review_queue'
      and policyname = 'service_role_full_access_on_content_review_queue'
  ) then
    create policy service_role_full_access_on_content_review_queue
      on public.content_review_queue
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end;
$$;