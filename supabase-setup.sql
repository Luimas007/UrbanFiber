-- ============================================================================
--  UrbanFiber — backend migration
--  Run this ONCE in: Supabase Dashboard -> SQL Editor -> New query -> Run
--  Safe to re-run: every statement is idempotent.
-- ============================================================================
--  Adds:   sale/clearance pricing, stock status, editable hero, announcement
--          ribbon, admin settings RPC, hardened storage policies.
--  Keeps:  your existing strict RLS model (anon reads products only; all
--          writes go through SECURITY DEFINER functions gated by is_admin()).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Products: clearance pricing + stock state
-- ---------------------------------------------------------------------------
alter table public.products add column if not exists sale_price_bdt numeric;
alter table public.products add column if not exists stock_status   text not null default 'in_stock';
alter table public.products add column if not exists sort_order     integer not null default 0;

-- A sale price must be a real discount, never negative, never above list price.
alter table public.products drop constraint if exists products_sale_price_valid;
alter table public.products add  constraint products_sale_price_valid
  check (sale_price_bdt is null or (sale_price_bdt >= 0 and sale_price_bdt < price_bdt));

alter table public.products drop constraint if exists products_stock_status_valid;
alter table public.products add  constraint products_stock_status_valid
  check (stock_status in ('in_stock','low_stock','sold_out'));

comment on column public.products.sale_price_bdt is
  'Clearance price. NULL = not on sale. Storefront shows price_bdt struck through beside this.';
comment on column public.products.stock_status is
  'in_stock | low_stock | sold_out. sold_out blocks add-to-cart and ordering.';

-- ---------------------------------------------------------------------------
-- 2. Site settings: editable hero + announcement ribbon (single row)
-- ---------------------------------------------------------------------------
create table if not exists public.site_settings (
  id               boolean primary key default true check (id),   -- forces one row
  hero_image_url   text,
  hero_headline    text,
  hero_subcopy     text,
  hero_cta_label   text not null default 'Shop the collection',
  ribbon_enabled   boolean not null default false,
  ribbon_label     text,
  ribbon_message   text,
  ribbon_href      text,
  free_delivery_over_bdt numeric,
  updated_at       timestamptz not null default now()
);

insert into public.site_settings (id) values (true) on conflict (id) do nothing;

comment on table public.site_settings is
  'Single-row store configuration editable from /admin. Publicly readable.';

-- ---------------------------------------------------------------------------
-- 3. RLS — site_settings: world-readable, admin-writable only via RPC
-- ---------------------------------------------------------------------------
alter table public.site_settings enable row level security;

drop policy if exists site_settings_public_read on public.site_settings;
create policy site_settings_public_read
  on public.site_settings for select
  to anon, authenticated
  using (true);

-- No INSERT/UPDATE/DELETE policy at all: writes are only possible through the
-- SECURITY DEFINER function below, which checks is_admin() itself.
revoke insert, update, delete on public.site_settings from anon, authenticated;
grant  select on public.site_settings to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Admin RPC: save settings
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5. Order creation — honours sale price and blocks sold-out items
--    Contract is unchanged from your current function:
--      in : { customer:{name,phone,district,area,postcode,address},
--             payment_method, items:[{product_id,color,size,quantity}] }
--      out: { order_id, order_number, subtotal_bdt, delivery_charge_bdt,
--             total_bdt, currency }
--    Prices are ALWAYS re-read from the products table. Anything the browser
--    sends about price is ignored.
-- ---------------------------------------------------------------------------
create or replace function public.create_guest_order(p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust      jsonb := coalesce(p_order->'customer','{}'::jsonb);
  v_items     jsonb := coalesce(p_order->'items','[]'::jsonb);
  v_item      jsonb;
  v_product   public.products;
  v_qty       integer;
  v_color     text;
  v_size      text;
  v_unit      numeric;
  v_subtotal  numeric := 0;
  v_delivery  numeric;
  v_free_over numeric;
  v_order_id  uuid;
  v_number    text;
  v_district  text;
  v_name      text;
  v_phone     text;
  v_area      text;
  v_address   text;
begin
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'Invalid order items' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_items) > 50 then
    raise exception 'Too many items' using errcode = 'P0001';
  end if;

  v_name    := nullif(trim(v_cust->>'name'), '');
  v_phone   := nullif(trim(v_cust->>'phone'), '');
  v_district:= nullif(trim(v_cust->>'district'), '');
  v_area    := nullif(trim(v_cust->>'area'), '');
  v_address := nullif(trim(v_cust->>'address'), '');

  if v_name is null or v_phone is null or v_district is null
     or v_area is null or v_address is null then
    raise exception 'Incomplete delivery details' using errcode = 'P0001';
  end if;

  -- Bangladesh mobile: 01[3-9] + 8 digits, optionally +88 prefixed.
  if regexp_replace(v_phone, '^\+?88', '') !~ '^01[3-9][0-9]{8}$' then
    raise exception 'Invalid mobile number' using errcode = 'P0001';
  end if;

  insert into public.orders (
    order_number, customer_name, phone, district, area, postcode, address,
    payment_method, delivery_charge_bdt, subtotal_bdt, total_bdt, status
  ) values (
    'PENDING', v_name, v_phone, v_district, v_area,
    nullif(trim(v_cust->>'postcode'),''), v_address,
    'cod', 0, 0, 0, 'pending'
  ) returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(v_items) loop
    v_qty := floor(coalesce((v_item->>'quantity')::numeric, 0))::integer;
    if v_qty is null or v_qty < 1 or v_qty > 20 then
      raise exception 'Invalid quantity' using errcode = 'P0001';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and active = true;
    if not found then
      raise exception 'Product unavailable' using errcode = 'P0001';
    end if;
    if v_product.stock_status = 'sold_out' then
      raise exception 'Sold out: %', v_product.name using errcode = 'P0001';
    end if;

    v_color := v_item->>'color';
    v_size  := v_item->>'size';
    if v_color is null or not (v_product.variants ? v_color) then
      raise exception 'Invalid product color' using errcode = 'P0001';
    end if;
    if v_size is null or not (v_product.sizes @> to_jsonb(v_size)) then
      raise exception 'Invalid product size' using errcode = 'P0001';
    end if;

    -- Sale price wins when present. Never trusted from the client.
    v_unit := coalesce(v_product.sale_price_bdt, v_product.price_bdt);
    v_subtotal := v_subtotal + (v_unit * v_qty);

    insert into public.order_items (
      order_id, product_id, product_name, color, size,
      quantity, unit_price_bdt, line_total_bdt
    ) values (
      v_order_id, v_product.id, v_product.name, v_color, v_size,
      v_qty, v_unit, v_unit * v_qty
    );
  end loop;

  -- Delivery: 60 inside Dhaka, 100 elsewhere; free above threshold if set.
  v_delivery := case when lower(v_district) = 'dhaka' then 60 else 100 end;
  select free_delivery_over_bdt into v_free_over from public.site_settings where id = true;
  if v_free_over is not null and v_subtotal >= v_free_over then
    v_delivery := 0;
  end if;

  v_number := 'UF-' || to_char(now() at time zone 'Asia/Dhaka', 'YYYYMMDD')
              || '-' || upper(substr(replace(v_order_id::text,'-',''), 1, 8));

  update public.orders set
    order_number        = v_number,
    subtotal_bdt        = v_subtotal,
    delivery_charge_bdt = v_delivery,
    total_bdt           = v_subtotal + v_delivery
  where id = v_order_id;

  return jsonb_build_object(
    'order_id',            v_order_id,
    'order_number',        v_number,
    'subtotal_bdt',        v_subtotal,
    'delivery_charge_bdt', v_delivery,
    'total_bdt',           v_subtotal + v_delivery,
    'currency',            'BDT'
  );
end;
$$;

revoke all on function public.create_guest_order(jsonb) from public;
grant execute on function public.create_guest_order(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5b. Product save — extended for sale price, stock, description, size chart.
--     Same contract as before (admin-only, upsert by id), plus the new fields.
-- ---------------------------------------------------------------------------
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
    description, size_chart_url, image_url, variants, sizes, active, is_featured, updated_at
  ) values (
    coalesce(v_id, gen_random_uuid()), v_name, v_slug,
    coalesce(nullif(trim(p_product->>'category'),''),'Oversized'),
    v_price, v_sale, v_stock,
    nullif(trim(p_product->>'description'),''),
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
    size_chart_url = excluded.size_chart_url, image_url = excluded.image_url,
    variants = excluded.variants, sizes = excluded.sizes,
    active = excluded.active, is_featured = excluded.is_featured, updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_save_product(jsonb) from public, anon;
grant execute on function public.admin_save_product(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Storage: stop anonymous users listing the bucket
--    (uploads were already blocked; listing was not)
-- ---------------------------------------------------------------------------
drop policy if exists "product images are publicly readable" on storage.objects;
create policy "product images are publicly readable"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'product-images');

drop policy if exists "only admins write product images" on storage.objects;
create policy "only admins write product images"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "only admins update product images" on storage.objects;
create policy "only admins update product images"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "only admins delete product images" on storage.objects;
create policy "only admins delete product images"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

-- ---------------------------------------------------------------------------
-- 7. Helpful indexes
-- ---------------------------------------------------------------------------
create index if not exists products_active_sort_idx
  on public.products (active, sort_order, created_at desc);
create index if not exists orders_status_created_idx
  on public.orders (status, created_at desc);
create index if not exists order_items_order_idx
  on public.order_items (order_id);

commit;

-- ============================================================================
--  AFTER RUNNING THIS, also do the following in the Dashboard (one click each):
--
--  1. Authentication -> Sign In / Providers -> Email
--       turn OFF "Allow new users to sign up"
--     Only you should have an account; the storefront never signs anyone in.
--
--  2. Verify it worked:
--       select sale_price_bdt, stock_status from public.products limit 1;
--       select * from public.site_settings;
-- ============================================================================
