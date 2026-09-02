# UrbanFiber

A buildless static storefront (cash-on-delivery, Bangladesh) with a Supabase
backend and a separate admin console. No framework, no bundler, no build
step — plain HTML/CSS/JS served as-is.

## Project layout

```
public/                 Everything served to the browser (the "publish
                         directory" for whatever host you use)
  index.html             Storefront
  admin.html              Admin console
  404.html                Kept byte-identical to index.html (client-side
                           routing needs every unknown path to resolve here)
  sw.js                    Service worker — caches images for fast repeat
                           visits; never caches HTML/JS, so a redeploy is
                           always picked up immediately
  CNAME, .nojekyll, robots.txt, sitemap.xml
  assets/
    config.js              The ONLY file with deployment-specific values —
                            see "Reconfiguring" below
    app.js                 Storefront logic
    admin.js                Admin console logic
    invoice.js               Shared invoice template (customer + admin see
                              byte-identical output for the same order)
  Materials/, brand*.*     Bundled photography

supabase/
  main_setup.sql          The entire database schema — single source of
                           truth, run once on a new Supabase project

design-sources/           Unused/original source art kept for reference,
                           not served by the site

.github/workflows/
  deploy.yml               Publishes public/ to GitHub Pages
  keepalive.yml             Daily ping so the Supabase backend never
                            auto-pauses from inactivity
```

## Reconfiguring this repo for a new deployment

Everything project-specific lives in exactly two places. Nothing else in
the codebase needs to change.

### 1. Database — `supabase/main_setup.sql`

On a **new, empty Supabase project**: Dashboard → SQL Editor → New query →
paste the whole file → Run. It creates every table, index, constraint, RLS
policy, function and storage bucket this app needs, and inserts zero
business data (only the one structurally-required settings row). Safe to
re-run.

Then, one-time, in the Dashboard (can't be scripted):
1. Authentication → Sign In / Providers → Email → turn **off** "Allow new
   users to sign up". This app has no customer accounts — only you should
   ever be able to create an admin login.
2. Authentication → Users → Add user, to create your own login, then run
   once in the SQL editor (with your new user's id):
   ```sql
   insert into public.admin_users (user_id) values ('<your-uid>');
   ```
3. Nothing to deploy under Edge Functions — every server-side operation is
   a plain SQL function created by `main_setup.sql` already.

### 2. Frontend — `public/assets/config.js`

Edit the two values in that file to your new project's URL and
**publishable** (anon) key, found in Supabase → Project Settings → API.
That key is safe to ship in browser code — it has no power on its own,
every table is RLS-protected and every write is re-checked server-side.
**Never** put the `sb_secret_...` / service-role key in frontend code.

### 3. Domain

- `public/CNAME` — your custom domain (delete the file entirely if you're
  using the default `*.github.io` URL instead).
- `public/robots.txt` / `public/sitemap.xml` — update the hardcoded domain
  in the `Sitemap:` line and `<loc>` entries.

## Deploying

### GitHub Pages (this repo's current host)

1. Push to `master` — `.github/workflows/deploy.yml` builds and publishes
   `public/` automatically.
2. One manual, one-time setting: **Settings → Pages → Build and
   deployment → Source → "GitHub Actions"** (not "Deploy from a branch").
   Do this once per repository/fork; it's what makes the workflow above
   take effect instead of GitHub's classic branch-root deploy.
3. Optional: **Settings → Secrets and variables → Actions → Variables →
   New repository variable** — `SITE_URL` = your production URL. This
   powers the daily keep-alive ping in `keepalive.yml`; without it, that
   workflow just skips itself with a warning, nothing breaks.

### Any other static host (Netlify, Vercel, Cloudflare Pages, Firebase
Hosting, etc.)

Point the host's "publish directory" / "output directory" setting at
`public/`. That's the entire platform-specific configuration — there is no
build command, because there is no build step.

## Local development

Any static file server pointed at `public/` works, e.g.:

```
npx serve public
```

The app talks directly to Supabase from the browser, so there's nothing
else to run locally.
