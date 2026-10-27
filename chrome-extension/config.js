/**
 * AI Context Bridge - shared runtime configuration.
 *
 * Loaded before every other extension script (popup page and service worker),
 * so both contexts read the same backend settings.
 *
 * To point the extension at a different Supabase project, change the two
 * values below. The anon key is a public client key and is safe to ship.
 */
var APP_CONFIG = Object.freeze({
  supabaseUrl: 'https://meqqbjhfmrpsiqsexcif.supabase.co',
  supabaseAnonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lcXFiamhmbXJwc2lxc2V4Y2lmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0MDkzNzUsImV4cCI6MjA4Mzk4NTM3NX0.pqoNxaO0CtEFpGSYOZ3JZk7S3B1EOEYuh9mymP1mDqI',
  authStorageKey: 'authSession',
  localProfilePrefix: 'local_',
  maxLocalContexts: 50,
  captureCooldownMs: 120000,
  defaultRecencyDays: 30,
});