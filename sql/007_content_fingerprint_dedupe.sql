-- Ayni ilanin birden fazla yayinlanmasini engellemek icin icerik parmak izi.
--
-- Telegram'da ayni kisi ayni ilani saniyeler arayla tekrar atabiliyor; her
-- mesaj ayri bir kayit olarak geldigi icin checksum'lar farkli cikiyor
-- (super admin checksum'a yayin anini da katiyor). Parmak izi yalnizca metne
-- bakar: bosluklar ve gorunmez karakterler atilir, harfler kucultulur.
--
-- Karsilastirma kurali tek yerde, burada tanimli. Super admin hem toplu AI
-- ayiklamadan once hem yayin aninda bu fonksiyonlari cagirir.

create or replace function public.content_fingerprint(p_text text)
returns text
language sql
immutable
parallel safe
as $$
  select encode(
    sha256(convert_to(
      lower(regexp_replace(coalesce(p_text, ''), '[[:space:]' || chr(160) || chr(8203) || '-' || chr(8205) || chr(8288) || chr(65279) || chr(65039) || ']+', '', 'g')),
      'UTF8'
    )),
    'hex'
  );
$$;

-- facts.signalItems icindeki her ilanin "cikis>varis" anahtari.
-- Ayni mesajdan bolunen kardes ilanlar ayni ham metni tasir; onlari kopya
-- saymamak icin yayin aninda metinle birlikte rota da karsilastirilir.
create or replace function public.signal_route_keys(p_facts jsonb)
returns text[]
language sql
immutable
parallel safe
as $$
  select coalesce(array_agg(distinct anahtar), '{}'::text[])
  from (
    select lower(regexp_replace(
      coalesce(item->>'origin', '') || '>' || coalesce(item->>'destination', ''),
      '[[:space:]]+', '', 'g'
    )) as anahtar
    from jsonb_array_elements(
      case when jsonb_typeof(p_facts->'signalItems') = 'array' then p_facts->'signalItems' else '[]'::jsonb end
    ) as item
  ) rotalar
  where anahtar <> '>';
$$;

alter table public.raw_content_ingest
  add column if not exists content_fingerprint text
  generated always as (public.content_fingerprint(raw_text)) stored;

create index if not exists idx_raw_content_ingest_content_fingerprint
  on public.raw_content_ingest(content_fingerprint);

-- Toplu AI ayiklamadan once: hangi metinler zaten yayinda?
-- input_index 1'den baslar (p_raw_texts sirasina gore).
create or replace function public.find_published_texts(p_raw_texts text[])
returns table (
  input_index integer,
  publish_target text,
  published_id uuid,
  title text,
  published_at timestamptz
)
language sql
stable
set search_path = public
as $$
  with girdi as (
    select ord::integer as input_index, public.content_fingerprint(metin) as fp
    from unnest(p_raw_texts) with ordinality as u(metin, ord)
  ),
  yayin as (
    select 'market-signal'::text as publish_target, id, raw_ingest_id, title, published_at
    from public.published_market_signals
    union all
    select 'sector-news'::text, id, raw_ingest_id, title, published_at
    from public.published_sector_news
  )
  select distinct on (g.input_index) g.input_index, y.publish_target, y.id, y.title, y.published_at
  from girdi g
  join public.raw_content_ingest r on r.content_fingerprint = g.fp
  join yayin y on y.raw_ingest_id = r.id
  order by g.input_index, y.published_at desc;
$$;

-- Yayin aninda: ayni metin + kesisen rota yayindaysa kopyadir.
-- Rota bilgisi iki taraftan birinde yoksa yalnizca metin karsilastirilir.
-- p_exclude_review_id: ayni kaydin yeniden yayinlanmasi kendisiyle eslesmesin.
create or replace function public.find_published_duplicate(
  p_raw_text text,
  p_facts jsonb default null,
  p_exclude_review_id uuid default null
)
returns table (
  publish_target text,
  published_id uuid,
  review_queue_id uuid,
  title text,
  published_at timestamptz
)
language sql
stable
set search_path = public
as $$
  with yeni as (
    select public.content_fingerprint(p_raw_text) as fp,
           public.signal_route_keys(coalesce(p_facts, '{}'::jsonb)) as rotalar
  ),
  yayin as (
    select 'market-signal'::text as publish_target, id, review_queue_id, raw_ingest_id, title, published_at, facts
    from public.published_market_signals
    union all
    select 'sector-news'::text, id, review_queue_id, raw_ingest_id, title, published_at, facts
    from public.published_sector_news
  )
  select y.publish_target, y.id, y.review_queue_id, y.title, y.published_at
  from yeni n
  join public.raw_content_ingest r on r.content_fingerprint = n.fp
  join yayin y on y.raw_ingest_id = r.id
  where (p_exclude_review_id is null or y.review_queue_id is distinct from p_exclude_review_id)
    and (
      cardinality(n.rotalar) = 0
      or cardinality(public.signal_route_keys(y.facts)) = 0
      or n.rotalar && public.signal_route_keys(y.facts)
    )
  order by y.published_at desc
  limit 1;
$$;

-- Sorgu fonksiyonlari yalnizca super admin'in service_role anahtariyla cagrilir.
-- content_fingerprint ve signal_route_keys saf fonksiyonlar; uretilen sutun
-- her ekleyen rol icin calisabilsin diye varsayilan yetkide birakildi.
revoke execute on function public.find_published_texts(text[]) from public, anon, authenticated;
revoke execute on function public.find_published_duplicate(text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.find_published_texts(text[]) to service_role;
grant execute on function public.find_published_duplicate(text, jsonb, uuid) to service_role;
