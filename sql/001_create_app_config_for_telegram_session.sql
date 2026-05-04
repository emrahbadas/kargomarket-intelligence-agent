create table if not exists public.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create or replace function public.set_app_config_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_app_config_updated_at on public.app_config;

create trigger trg_app_config_updated_at
before update on public.app_config
for each row
execute function public.set_app_config_updated_at();

alter table public.app_config enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'app_config'
      and policyname = 'service_role_full_access_on_app_config'
  ) then
    create policy service_role_full_access_on_app_config
      on public.app_config
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end;
$$;

insert into public.app_config(key, value)
values ('telegram_session_string', '')
on conflict (key) do nothing;