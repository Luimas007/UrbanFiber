/* ==========================================================================
   UrbanFiber — deployment configuration

   This is the ONLY file you should need to edit to point this repository
   at a different Supabase project (a fresh copy of the app, a staging
   environment, a different account). Both index.html and admin.html load
   this file first, before app.js / admin.js / invoice.js.

   supabaseKey is the PUBLISHABLE (anon) key — Supabase's own naming for a
   key that is SAFE to ship in browser code. It has no power on its own;
   every table is protected by Row Level Security and every write goes
   through a SECURITY DEFINER function that re-checks admin status itself
   (see supabase/main_setup.sql). Never put the sb_secret_ / service_role
   key here, or anywhere else in this frontend — that key bypasses RLS
   entirely and must stay server-side only.
   ========================================================================== */
window.__UF_CONFIG__ = {
  supabaseUrl: 'https://trmbifurircmdgyfbcyd.supabase.co',
  supabaseKey: 'sb_publishable_tJZewP60zmo8-YJDskLTJw_-NGHJnke'
};

// Pre-warm the connection to Supabase as early in the page load as possible.
(function () {
  var link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = window.__UF_CONFIG__.supabaseUrl;
  link.crossOrigin = '';
  document.head.appendChild(link);
})();
