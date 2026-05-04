create table if not exists public.telegram_channel_cursors (
  channel_ref text primary key,
  last_message_id bigint null,
  last_message_date timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_telegram_channel_cursors_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_telegram_channel_cursors_updated_at on public.telegram_channel_cursors;

create trigger trg_telegram_channel_cursors_updated_at
before update on public.telegram_channel_cursors
for each row
execute function public.set_telegram_channel_cursors_updated_at();

alter table public.telegram_channel_cursors enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'telegram_channel_cursors'
      and policyname = 'service_role_full_access_on_telegram_channel_cursors'
  ) then
    create policy service_role_full_access_on_telegram_channel_cursors
      on public.telegram_channel_cursors
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end;
$$;