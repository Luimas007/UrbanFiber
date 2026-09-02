-- ============================================================================
--  UrbanFiber — complete database setup
--  Run ONCE, top to bottom, on a brand-new Supabase project:
--    Dashboard -> SQL Editor -> New query -> paste this whole file -> Run
--
--  This is the single source of truth for the schema. It creates every
--  table, constraint, index, RLS policy, function and storage bucket this
--  app needs, starting from nothing. It inserts ZERO business data — the
--  only row it creates is the mandatory single settings row (a structural
--  singleton, not "content"; the storefront and admin panel both fall back
--  to sensible defaults for every column in it).
--
--  Safe to re-run: every statement is idempotent (create-if-not-exists /
--  create-or-replace / drop-then-create for policies).
--
--  After running this file, also do the following in the Dashboard
--  (one-off, cannot be scripted):
--    1. Authentication -> Sign In / Providers -> Email
--         turn OFF "Allow new users to sign up".
--       This app has no customer accounts; the storefront never signs
--       anyone in, and only you should ever be able to create an admin.
--    2. Authentication -> Users -> Add user, to create your own admin
--       login, then run once (with YOUR user's id):
--         insert into public.admin_users (user_id) values ('<your-uid>');
--    3. This project uses no Supabase Edge Functions — every server-side
--       operation is a plain SQL function (SECURITY DEFINER RPC) created
--       by this file, deployed the moment you run it. There is nothing
--       separate to `supabase functions deploy`.
--    4. Update assets/config.js with this project's URL and publishable
--       (anon) key — see that file for exactly what to change.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

-- 1a. admin_users — the entire authorization model. Membership here (and
--     only here) makes a signed-in Supabase Auth user an admin. Every write
--     anywhere in this app is gated by is_admin(), which reads this table.
create table if not exists public.admin_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
comment on table public.admin_users is
  'Membership grants admin access. Managed only via the Dashboard/service role — never exposed to clients.';

-- 1b. products
create table if not exists public.products (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  slug           text not null,
  category       text,
  price_bdt      numeric(12,2) not null check (price_bdt >= 0),
  sale_price_bdt numeric(12,2),
  stock_status   text not null default 'in_stock',
  sort_order     integer not null default 0,
  fabric_type    text,
  description    text,
  size_chart_url text,
  image_url      text,
  variants       jsonb not null default '{}'::jsonb,
  sizes          jsonb not null default '[]'::jsonb,
  active         boolean not null default true,
  is_featured    boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint products_slug_unique unique (slug),
  constraint products_sale_price_valid
    check (sale_price_bdt is null or (sale_price_bdt >= 0 and sale_price_bdt < price_bdt)),
  constraint products_stock_status_valid
    check (stock_status in ('in_stock','low_stock','sold_out'))
);
comment on column public.products.variants is
  'Object mapping colour slug -> photo URL, e.g. {"black": "https://.../black.jpg"}.';
comment on column public.products.sizes is
  'JSON array of size labels, e.g. ["S","M","L","XL"].';
comment on column public.products.sale_price_bdt is
  'Clearance price. NULL = not on sale. Storefront shows price_bdt struck through beside this.';
comment on column public.products.stock_status is
  'in_stock | low_stock | sold_out. sold_out blocks add-to-cart and ordering.';
comment on column public.products.fabric_type is
  'Free-text fabric description, e.g. "220 GSM heavyweight cotton". Optional — shown on the product page when set.';

-- 1c. orders
create table if not exists public.orders (
  id                   uuid primary key default gen_random_uuid(),
  order_number         text not null,
  customer_name        text not null,
  phone                text not null,
  district             text not null,
  area                 text not null,
  postcode             text,
  address              text not null,
  payment_method       text not null default 'cod',
  status               text not null default 'pending',
  subtotal_bdt         numeric(12,2) not null default 0,
  delivery_charge_bdt  numeric(12,2) not null default 0,
  total_bdt            numeric(12,2) not null default 0,
  created_at           timestamptz not null default now(),
  accepted_at          timestamptz,
  shipped_at           timestamptz,
  completed_at         timestamptz,
  cancelled_at         timestamptz,
  constraint orders_order_number_unique unique (order_number),
  constraint orders_status_check
    check (status in ('pending','accepted','shipped','completed','cancelled'))
);
comment on table public.orders is
  'Cash-on-delivery guest orders. Created only via create_guest_order(); status only via admin_set_order_status().';

-- 1d. order_items — a snapshot of product/price at order time, independent
--     of later product edits or deletion (product_id may become NULL).
create table if not exists public.order_items (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders (id) on delete cascade,
  product_id      uuid references public.products (id) on delete set null,
  product_name    text not null,
  color           text not null,
  size            text not null,
  quantity        integer not null check (quantity > 0),
  unit_price_bdt  numeric(12,2) not null,
  line_total_bdt  numeric(12,2) not null,
  created_at      timestamptz not null default now()
);

-- 1e. site_settings — single-row store configuration (hero, announcement
--     ribbon, delivery threshold). The boolean PK forces exactly one row.
create table if not exists public.site_settings (
  id                     boolean primary key default true check (id),
  hero_image_url         text,
  hero_headline          text,
  hero_subcopy           text,
  hero_cta_label         text not null default 'Shop the collection',
  hero_images            jsonb not null default '[]'::jsonb,
  model_images           jsonb not null default '[]'::jsonb,
  ribbon_enabled         boolean not null default false,
  ribbon_label           text,
  ribbon_message         text,
  ribbon_href            text,
  free_delivery_over_bdt numeric,
  updated_at             timestamptz not null default now()
);
comment on table public.site_settings is
  'Single-row store configuration editable from /admin. Publicly readable.';
comment on column public.site_settings.hero_images is
  'Array of image URLs shown as a crossfading hero. Empty = the bundled default images are used.';
comment on column public.site_settings.model_images is
  'Array of image URLs for the "Worn in the City" rail. Empty = the bundled default photos are used.';

-- The one structurally-required row (not business data — see header note).
insert into public.site_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------
create index if not exists products_active_sort_idx
  on public.products (active, sort_order, created_at desc);
create index if not exists orders_status_created_idx
  on public.orders (status, created_at desc);
create index if not exists order_items_order_idx
  on public.order_items (order_id);
create index if not exists order_items_product_idx
  on public.order_items (product_id);

-- ---------------------------------------------------------------------------
-- 3. Row Level Security
--    Model: anon can only read published products; nothing else is
--    directly readable or writable by anon/authenticated. Every write, and
--    every order/settings read, goes through a SECURITY DEFINER function
--    below that re-checks is_admin() itself — RLS here is a backstop, not
--    the only gate. The only "authenticated" users this app ever creates
--    are admins (public sign-up is turned off in the Dashboard), so a
--    blanket authenticated policy below is equivalent to an admin-only one.
-- ---------------------------------------------------------------------------
alter table public.admin_users  enable row level security;
alter table public.products     enable row level security;
alter table public.orders       enable row level security;
alter table public.order_items  enable row level security;
alter table public.site_settings enable row level security;

-- admin_users: no client-facing policy at all. Managed via the Dashboard
-- (service role) only; read exclusively through is_admin() below.

-- products: anon + authenticated may read published products; the admin
-- console reads every product (including hidden ones) as an authenticated
-- session, which is fine because every authenticated user here is an admin.
drop policy if exists products_public_read on public.products;
create policy products_public_read
  on public.products for select
  to anon
  using (active = true);

drop policy if exists products_admin_read on public.products;
create policy products_admin_read
  on public.products for select
  to authenticated
  using (true);

-- orders / order_items: no anon access at all. Authenticated (= admin)
-- reads everything; all writes happen inside the SECURITY DEFINER
-- functions below, which run with elevated privilege and bypass RLS.
drop policy if exists orders_admin_read on public.orders;
create policy orders_admin_read
  on public.orders for select
  to authenticated
  using (true);

drop policy if exists order_items_admin_read on public.order_items;
create policy order_items_admin_read
  on public.order_items for select
  to authenticated
  using (true);

-- site_settings: world-readable (the homepage needs it signed out);
-- writable only through admin_save_settings() below.
drop policy if exists site_settings_public_read on public.site_settings;
create policy site_settings_public_read
  on public.site_settings for select
  to anon, authenticated
  using (true);

revoke insert, update, delete on public.site_settings from anon, authenticated;
revoke insert, update, delete on public.products      from anon, authenticated;
revoke insert, update, delete on public.orders         from anon, authenticated;
revoke insert, update, delete on public.order_items    from anon, authenticated;
grant  select on public.site_settings to anon, authenticated;
grant  select on public.products      to anon, authenticated;
grant  select on public.orders        to authenticated;
grant  select on public.order_items   to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Functions
-- ---------------------------------------------------------------------------

-- 4a. is_admin() — the single source of truth every RPC below checks.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- 4b. create_guest_order — the checkout endpoint. Anonymous, no account
--     needed. Prices are always re-read from products; nothing the client
--     sends about price is trusted.
--     in : { customer:{name,phone,district,area,postcode,address},
--            payment_method, items:[{product_id,color,size,quantity}] }
--     out: { order_id, order_number, subtotal_bdt, delivery_charge_bdt,
--            total_bdt, currency }
create or replace function public.create_guest_order(p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id     uuid := gen_random_uuid();
  v_order_number text;
  v_customer     jsonb := coalesce(p_order->'customer','{}'::jsonb);
  v_items        jsonb := coalesce(p_order->'items','[]'::jsonb);
  v_district     text  := lower(trim(coalesce(v_customer->>'district','')));
  v_phone        text  := regexp_replace(trim(coalesce(v_customer->>'phone','')),'[^0-9]','','g');
  v_delivery     numeric(12,2);
  v_subtotal     numeric(12,2) := 0;
  v_total        numeric(12,2);
  v_free_over    numeric(12,2);
  v_item         jsonb;
  v_product      public.products%rowtype;
  v_qty          integer;
  v_color        text;
  v_size         text;
  v_unit         numeric(12,2);
  v_line         numeric(12,2);
  v_count        integer := 0;
begin
  if jsonb_typeof(v_items) <> 'array'
     or jsonb_array_length(v_items) < 1
     or jsonb_array_length(v_items) > 30 then
    raise exception 'Invalid order items';
  end if;

  if length(trim(coalesce(v_customer->>'name',''))) not between 2 and 120 then
    raise exception 'Invalid customer name';
  end if;

  -- Accept 01XXXXXXXXX, 8801XXXXXXXXX and +8801XXXXXXXXX (spaces/dashes ok).
  v_phone := regexp_replace(v_phone, '^88', '');
  if v_phone !~ '^01[3-9][0-9]{8}$' then
    raise exception 'Invalid Bangladesh phone number';
  end if;

  if length(trim(coalesce(v_customer->>'district',''))) not between 2 and 80 then
    raise exception 'Invalid district';
  end if;
  if length(trim(coalesce(v_customer->>'area',''))) not between 2 and 120 then
    raise exception 'Invalid area';
  end if;
  if length(trim(coalesce(v_customer->>'address',''))) not between 5 and 500 then
    raise exception 'Invalid address';
  end if;
  if coalesce(v_customer->>'postcode','') <> ''
     and v_customer->>'postcode' !~ '^[0-9]{4}$' then
    raise exception 'Invalid postcode';
  end if;
  if coalesce(p_order->>'payment_method','cod') <> 'cod' then
    raise exception 'Unsupported payment method';
  end if;

  v_delivery := case when v_district = 'dhaka' then 60.00 else 100.00 end;
  v_order_number := 'UF-' || to_char(now() at time zone 'Asia/Dhaka','YYYYMMDD')
                    || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));

  insert into public.orders(
    id, order_number, customer_name, phone, district, area, postcode, address,
    payment_method, delivery_charge_bdt, subtotal_bdt, total_bdt
  ) values (
    v_order_id, v_order_number, trim(v_customer->>'name'), v_phone,
    trim(v_customer->>'district'), trim(v_customer->>'area'),
    nullif(trim(v_customer->>'postcode'),''), trim(v_customer->>'address'),
    'cod', v_delivery, 0, v_delivery
  );

  for v_item in select value from jsonb_array_elements(v_items) loop
    v_count := v_count + 1;

    if v_item->>'product_id' is null
       or v_item->>'product_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'Invalid product';
    end if;
    if (v_item->>'quantity') is null or (v_item->>'quantity') !~ '^[0-9]+$' then
      raise exception 'Invalid quantity';
    end if;
    v_qty := (v_item->>'quantity')::integer;
    if v_qty < 1 or v_qty > 20 then raise exception 'Invalid quantity'; end if;

    v_color := lower(trim(coalesce(v_item->>'color','')));
    v_size  := upper(trim(coalesce(v_item->>'size','')));

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and active = true
      for share;
    if not found then raise exception 'Product is unavailable'; end if;

    if v_product.stock_status = 'sold_out' then
      raise exception 'Sold out: %', v_product.name;
    end if;
    if v_color = '' or not (v_product.variants ? v_color) then
      raise exception 'Invalid product color';
    end if;
    if v_size = '' or not (v_product.sizes ? v_size) then
      raise exception 'Invalid product size';
    end if;

    v_unit := coalesce(v_product.sale_price_bdt, v_product.price_bdt);
    v_line := v_unit * v_qty;
    v_subtotal := v_subtotal + v_line;

    insert into public.order_items(
      order_id, product_id, product_name, color, size,
      quantity, unit_price_bdt, line_total_bdt
    ) values (
      v_order_id, v_product.id, v_product.name, v_color, v_size,
      v_qty, v_unit, v_line
    );
  end loop;

  if v_count = 0 then raise exception 'Empty order'; end if;

  select free_delivery_over_bdt into v_free_over from public.site_settings where id = true;
  if v_free_over is not null and v_subtotal >= v_free_over then
    v_delivery := 0;
  end if;

  v_total := v_subtotal + v_delivery;
  update public.orders
     set subtotal_bdt = v_subtotal,
         delivery_charge_bdt = v_delivery,
         total_bdt = v_total
   where id = v_order_id;

  return jsonb_build_object(
    'order_id', v_order_id, 'order_number', v_order_number,
    'subtotal_bdt', v_subtotal, 'delivery_charge_bdt', v_delivery,
    'total_bdt', v_total, 'currency', 'BDT'
  );
end;
$$;

revoke all on function public.create_guest_order(jsonb) from public;
grant execute on function public.create_guest_order(jsonb) to anon, authenticated;

-- 4c. admin_save_product — admin-only upsert by id.
create or replace function public.admin_save_product(p_product jsonb)
returns public.products
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   public.products;
  v_id    uuid   := nullif(p_product->>'id','')::uuid;
  v_name  text   := nullif(trim(p_product->>'name'),'');
  v_slug  text   := nullif(trim(p_product->>'slug'),'');
  v_price numeric:= (p_product->>'price_bdt')::numeric;
  v_sale  numeric:= nullif(p_product->>'sale_price_bdt','')::numeric;
  v_stock text   := coalesce(nullif(p_product->>'stock_status',''),'in_stock');
begin
  if not public.is_admin() then
    raise exception 'Unauthorized' using errcode = 'P0001';
  end if;
  if v_name is null or v_slug is null then
    raise exception 'Name and slug are required' using errcode = 'P0001';
  end if;
  if v_price is null or v_price < 0 then
    raise exception 'Invalid price' using errcode = 'P0001';
  end if;
  if v_sale is not null and v_sale >= v_price then
    raise exception 'Sale price must be lower than the normal price' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_product->'variants') <> 'object'
     or p_product->'variants' = '{}'::jsonb then
    raise exception 'At least one colour is required' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_product->'sizes') <> 'array'
     or jsonb_array_length(p_product->'sizes') = 0 then
    raise exception 'At least one size is required' using errcode = 'P0001';
  end if;

  insert into public.products as t (
    id, name, slug, category, price_bdt, sale_price_bdt, stock_status,
    description, fabric_type, size_chart_url, image_url, variants, sizes,
    active, is_featured, updated_at
  ) values (
    coalesce(v_id, gen_random_uuid()), v_name, v_slug,
    coalesce(nullif(trim(p_product->>'category'),''),'Oversized'),
    v_price, v_sale, v_stock,
    nullif(trim(p_product->>'description'),''),
    nullif(trim(p_product->>'fabric_type'),''),
    nullif(trim(p_product->>'size_chart_url'),''),
    p_product->>'image_url', p_product->'variants', p_product->'sizes',
    coalesce((p_product->>'active')::boolean, true),
    coalesce((p_product->>'is_featured')::boolean, false),
    now()
  )
  on conflict (id) do update set
    name = excluded.name, slug = excluded.slug, category = excluded.category,
    price_bdt = excluded.price_bdt, sale_price_bdt = excluded.sale_price_bdt,
    stock_status = excluded.stock_status, description = excluded.description,
    fabric_type = excluded.fabric_type,
    size_chart_url = excluded.size_chart_url, image_url = excluded.image_url,
    variants = excluded.variants, sizes = excluded.sizes,
    active = excluded.active, is_featured = excluded.is_featured, updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_save_product(jsonb) from public, anon;
grant execute on function public.admin_save_product(jsonb) to authenticated;

-- 4d. admin_delete_product — hard-deletes a product with no order history;
--     otherwise soft-deletes (hides it) so past orders keep their context.
create or replace function public.admin_delete_product(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Unauthorized' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.order_items where product_id = p_product_id) then
    update public.products set active = false, updated_at = now() where id = p_product_id;
  else
    delete from public.products where id = p_product_id;
  end if;
end;
$$;

revoke all on function public.admin_delete_product(uuid) from public, anon;
grant execute on function public.admin_delete_product(uuid) to authenticated;

-- 4e. admin_save_settings — admin-only, updates the single settings row.
create or replace function public.admin_save_settings(p_settings jsonb)
returns public.site_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.site_settings;
begin
  if not public.is_admin() then
    raise exception 'Unauthorized' using errcode = 'P0001';
  end if;

  update public.site_settings set
    hero_image_url = nullif(trim(coalesce(p_settings->>'hero_image_url', hero_image_url)), ''),
    hero_headline  = nullif(trim(coalesce(p_settings->>'hero_headline',  hero_headline)),  ''),
    hero_subcopy   = nullif(trim(coalesce(p_settings->>'hero_subcopy',   hero_subcopy)),   ''),
    hero_cta_label = coalesce(nullif(trim(coalesce(p_settings->>'hero_cta_label','')),''), hero_cta_label),
    hero_images    = case when jsonb_typeof(p_settings->'hero_images')  = 'array'
                          then p_settings->'hero_images'  else hero_images  end,
    model_images   = case when jsonb_typeof(p_settings->'model_images') = 'array'
                          then p_settings->'model_images' else model_images end,
    ribbon_enabled = coalesce((p_settings->>'ribbon_enabled')::boolean, ribbon_enabled),
    ribbon_label   = nullif(trim(coalesce(p_settings->>'ribbon_label',   ribbon_label)),   ''),
    ribbon_message = nullif(trim(coalesce(p_settings->>'ribbon_message', ribbon_message)), ''),
    ribbon_href    = nullif(trim(coalesce(p_settings->>'ribbon_href',    ribbon_href)),    ''),
    free_delivery_over_bdt = nullif(p_settings->>'free_delivery_over_bdt','')::numeric,
    updated_at     = now()
  where id = true
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_save_settings(jsonb) from public, anon;
grant execute on function public.admin_save_settings(jsonb) to authenticated;

-- 4f. admin_set_order_status — the only way an order's status ever changes.
--     pending -> accepted -> shipped -> completed, with cancellation
--     allowed from pending/accepted/shipped. completed/cancelled are
--     terminal (immutable).
create or replace function public.admin_set_order_status(p_order_id uuid, p_status text)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare v_order public.orders%rowtype;
begin
  if not public.is_admin() then raise exception 'Unauthorized'; end if;
  if p_status not in ('pending','accepted','shipped','completed','cancelled') then raise exception 'Invalid status'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if v_order.status='completed' and p_status<>'completed' then raise exception 'Completed orders are immutable'; end if;
  if v_order.status='cancelled' and p_status<>'cancelled' then raise exception 'Cancelled orders are immutable'; end if;
  if p_status='shipped' and v_order.status<>'accepted' then raise exception 'Order must be accepted before shipping'; end if;
  if p_status='completed' and v_order.status<>'shipped' then raise exception 'Order must be shipped before completion'; end if;
  if p_status='accepted' and v_order.status<>'pending' then raise exception 'Only pending orders can be accepted'; end if;
  if p_status='cancelled' and v_order.status not in ('pending','accepted','shipped') then raise exception 'Invalid cancellation'; end if;
  update public.orders set
    status=p_status,
    accepted_at=case when p_status='accepted' then coalesce(accepted_at,now()) else accepted_at end,
    shipped_at=case when p_status='shipped' then coalesce(shipped_at,now()) else shipped_at end,
    completed_at=case when p_status='completed' then now() else completed_at end,
    cancelled_at=case when p_status='cancelled' then now() else cancelled_at end
  where id=p_order_id returning * into v_order;
  return v_order;
end;
$$;

revoke all on function public.admin_set_order_status(uuid, text) from public, anon;
grant execute on function public.admin_set_order_status(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Storage — the "product-images" bucket
--    Public bucket: <img> tags load via /storage/v1/object/public/... which
--    never consults RLS, so photos work with zero auth. RLS below only
--    controls the OTHER storage endpoints — listing and any write — which
--    must stay admin-only so nobody can enumerate every uploaded file or
--    tamper with them.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

drop policy if exists "admins read product images"   on storage.objects;
drop policy if exists "admins write product images"  on storage.objects;
drop policy if exists "admins update product images" on storage.objects;
drop policy if exists "admins delete product images"  on storage.objects;
drop policy if exists "product images are publicly readable" on storage.objects;
drop policy if exists "only admins write product images"  on storage.objects;
drop policy if exists "only admins update product images" on storage.objects;
drop policy if exists "only admins delete product images" on storage.objects;

create policy "admins read product images"
  on storage.objects for select to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

create policy "admins write product images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and public.is_admin());

create policy "admins update product images"
  on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

create policy "admins delete product images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

commit;

-- ============================================================================
--  Verify it worked:
--    select count(*) from public.products;       -- 0 (empty catalogue)
--    select * from public.site_settings;         -- 1 row, all defaults
--    select public.is_admin();                   -- false (not signed in yet)
--
--  Then follow the three Dashboard steps at the top of this file before
--  opening admin.html.
-- ============================================================================
