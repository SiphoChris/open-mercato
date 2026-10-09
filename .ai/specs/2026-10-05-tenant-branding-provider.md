# Tenant Branding Provider

- **Status:** Implemented — PR A (contract, resolver, default provider, backend chrome) and PR B (shells, layouts, login, first paint; branch `feat/tenant-branding-shells`, building on PR A). Sections, rows and guarantees marked PR B are delivered by this branch.
- **Scope:** OSS (`@open-mercato/shared`, `@open-mercato/ui`, `@open-mercato/core`, `apps/mercato`, create-app template, docs)
- **Follows up:** [`2026-07-05-ds-theming-and-brand-customization.md`](2026-07-05-ds-theming-and-brand-customization.md) (runtime per-tenant theming was its declared non-goal), [`2026-06-08-organization-sidebar-logo.md`](2026-06-08-organization-sidebar-logo.md) (the organization logo channel this spec generalises)
- **Risk:** `risk-high` (authentication surfaces, tenant and organization scoping of the backend chrome, and a new shared contract; every change is additive) · **Priority:** `priority-medium`
- **Category:** `feature`

## TLDR

Multi-tenant apps built on Open Mercato cannot brand the product per tenant at runtime. This spec adds a **tenant branding provider contract**: a DI-registered `tenantBrandingProvider` that returns a `TenantBranding` (product name, light/dark/mark logos, and a brand style in the existing `BrandStyle` format) for a `{ tenantId, organizationId, host, surface }` request. The result is resolved **server-side, before first paint** in the backend shell, the customer portal shell and the login page, is cached per tenant through the DI `cache` service with tag-based invalidation, and degrades to the built-in default on any failure.

The built-in default provider reproduces today's behaviour: the selected organization's `logoUrl` in the backend, nothing on the portal and login surfaces, and no brand style. For an app that registers nothing: the `/api/auth/admin/nav` `brand` is identical for every organization row; the portal and login markup is identical; the backend markup is identical when the scoped organization has no logo, and when it has one the server-rendered sidebar already shows the logo the chrome used to deliver after its fetch (see Guarantees).

## Overview

Today branding comes from three unrelated places:

| Surface | Logo today | Product name today | Colours today |
|---|---|---|---|
| Backend shell (`AppShell`) | selected organization `logoUrl`, delivered client-side by `/api/auth/admin/nav` (`backendChrome.brand`) | i18n `appShell.productName` (+ `DEPLOY_ENV` suffix) | none (build-time `theme.css` only) |
| Portal shell (`PortalShell`) | `logo` prop exists but `PortalLayoutShell` never passes one → always `/open-mercato.svg` | organization name | none |
| Login page (`LoginPage`) | hard-coded `/open-mercato.svg` | i18n `auth.login.brandName` | none |
| Any surface | per-browser design-system gallery preview (`localStorage` `BrandStyle`) | — | per-browser gallery preview, injected client-side after hydration |

There is no dark-mode logo, no per-tenant colour, and the only colour override paints after the default theme (a visible flash).

## Problem Statement

1. A deployment serving several tenants (for example an `acme` tenant on `acme.example.com`) cannot show that tenant's logo or colours on the login page, the portal or the backend without forking the app shell.
2. The organization logo arrives through a client fetch, so the first paint always shows the platform logo.
3. Dark mode has no logo variant; a dark wordmark disappears on a dark sidebar.
4. The `BrandStyle` contract (with its WCAG contrast validation) exists but is reachable only from the per-browser gallery.

## Proposed Solution

### Delivery: two PRs

| PR | Branch | Delivers | Visible effect on its own |
|---|---|---|---|
| A | `feat/tenant-branding-provider` | the contract and resolver (`@open-mercato/shared/lib/branding/*`, including the `BrandStyle` move with the ui re-export), the directory default provider (and the shared organization logo rule the directory validators now use), DI keys and invalidation subscriber, the backend chrome and `/api/auth/admin/nav` going through the provider, the optional `BackendChromeBrand` fields, the backend shell rendering the provider's brand logo unoptimised (its own `logo` prop keeps the existing rule), their unit tests (including a Next `getImgProps` test), the `TC-DIR-019` integration spec, this spec, the guide and the upgrade notes | none for an app that registers nothing (G1, byte-identical nav brand); a registered provider brands the backend sidebar logo and name through the nav payload |
| B | `feat/tenant-branding-shells` (builds on A) | server-side resolution in the backend, portal and login layouts with their template mirrors, the shells' initial brand, dark logo, mark and client branding props (`toClientTenantBranding`), `TenantBrandStyle`, the gallery preview layer (`brandStyleCss` `layer: 'preview'`), the tenant-existence cache, `TC-DIR-020`, and the monorepo-only `branding_probe` with `TC-BRANDING-001` (kept out of the template) | branding, colours and dark logos before first paint on every surface |

PR A is a no-UI change that keeps every existing output (G1), so it can be reviewed and merged on its own; PR B is where the user-visible work and the integration evidence live. The interlocks (the layouts and the chrome must resolve the same scope; the default provider must reproduce the chrome's `brand`; invalidation must reach both caches) are inside PR A, so neither PR ships a state that contradicts this spec. Guarantees below name the PR that delivers them.

### Contract (`@open-mercato/shared/lib/branding/tenantBranding`)

```ts
export type TenantBrandingSurface = 'backend' | 'portal' | 'auth'

export type TenantBrandingLogo = {
  src: string                    // root-relative path, https:// URL or base64 'data:image/(png|jpeg|webp|gif|svg+xml)' URL
  alt?: string
  preserveAspectRatio?: boolean  // backend sidebar: contain instead of the cropped icon treatment
}

export type TenantBranding = {
  productName?: string
  logos?: {
    light: TenantBrandingLogo
    dark?: TenantBrandingLogo    // used under `.dark`; falls back to `light`
    mark?: TenantBrandingLogo    // square mark for compact slots (collapsed sidebar, portal header)
  }
  style?: BrandStyle             // the existing BrandStyle format, validated by its schema
}

export type ClientTenantBranding = Pick<TenantBranding, 'productName' | 'logos'>  // PR B: what client components receive

export type TenantBrandingResolveInput = {
  tenantId: string | null
  organizationId: string | null
  host: string | null            // null unless the provider declares varyByHost
  surface: TenantBrandingSurface
}

export interface TenantBrandingProvider {
  resolve(input: TenantBrandingResolveInput): Promise<TenantBranding | null>
  varyByHost?: boolean           // opt in to the request host; host-dependent results are never cached by the resolver
}

export const TENANT_BRANDING_PROVIDER_DI_KEY = 'tenantBrandingProvider'
export const DEFAULT_TENANT_BRANDING_PROVIDER_DI_KEY = 'defaultTenantBrandingProvider'
```

Validation (`parseTenantBranding`) is field by field: an invalid logo is dropped on its own (an invalid `light` logo drops the `logos` group, whose `dark` and `mark` only refine it), an invalid style or a blank product name (empty after trimming) is dropped, unknown fields are ignored, and every drop is listed in `issues` and logged at debug level; only a value that is not an object at all is a failure. `productName` and `alt` are otherwise free strings (React escapes them). Every logo `src`, whichever provider returns it, follows one rule: a well-formed string (no lone UTF-16 surrogates, which make `next/image` throw) without surrounding whitespace that is either a canonical source — a root-relative path (`/…`, not `//` or `/\`, query and fragment kept), an `https://` URL in any case that parses with `new URL` (scheme lower-cased, the rest verbatim), or a base64 image data URL up to 64 KB — or a source the directory accepts for organization logos (`organizationLogoUrlSchema`, the exact rule the directory validators use, now shared and imported by them), kept verbatim. G1 therefore holds for every organization logo the directory accepts (`http://`, underscores, trailing dots, credentials and so on render exactly as before), also when a registered provider delegates to the default one, without tracking where a logo came from; the trade-off is that any provider may return such sources too. Logos a provider supplies — the chrome `brand` in PR A, the shells' initial brand, portal branding and login branding in PR B — always render without the Next.js image optimiser, which rejects unconfigured hosts and query strings (Next's default `images.localPatterns`), serves SVG only when it can tell from a lower-case `.svg` suffix, and fetches without the visitor's cookies. The `logo` prop an app passes to a shell keeps its existing rule (absolute and attachment URLs unoptimised, other paths optimised). Every accepted source renders under Next's default image configuration in development and production (G5). `style.logo` is set to `null` (tenant logos travel in `logos`).

`BrandStyle`, its zod schema and `brandStyleCss()` move from `@open-mercato/ui/theme/brand-style` to `@open-mercato/shared/lib/branding/brandStyle` so the server-side contract can reference them; `@open-mercato/ui/theme/brand-style` re-exports them unchanged (no import path breaks). PR B adds `brandStyleCss(style, { layer: 'preview' })`, which emits `html:root…` selectors; without the option the output is unchanged.

### DI registration

The `directory` module registers two keys:

| Key | Value | Overridable |
|---|---|---|
| `defaultTenantBrandingProvider` | organization-backed provider (below) | yes, but intended as the stable fallback |
| `tenantBrandingProvider` | resolves to `defaultTenantBrandingProvider` | **yes — this is the app extension point** |

Apps override `tenantBrandingProvider` in `src/di.ts` (runs after module registrars). A custom provider can compose with the default by resolving `defaultTenantBrandingProvider` from the cradle.

### Default provider

`createOrganizationTenantBrandingProvider({ em })` returns, for `surface: 'backend'` with a UUID tenant and organization whose `logoUrl` is set: `{ productName: organization.name, logos: { light: { src: logoUrl, alt: '<name> logo', preserveAspectRatio } } }` — the `logoUrl` exactly as stored. For every other input — other surfaces, missing or non-UUID ids — it returns `null` without querying. That is the `backendChrome.brand` value computed before this change (a blank organization name is no longer passed on as the brand name), and nothing for portal/auth. On a resolver cache miss it runs its own indexed organization query; the resolver caches the answer for five minutes. It is never put behind a failure window, and its exceptions are reported (`branding.default_provider_failed`).

### Resolver (`@open-mercato/shared/lib/branding/resolveTenantBranding`)

`resolveTenantBranding(container, input)`:

1. Looks up `tenantBrandingProvider` and `defaultTenantBrandingProvider`, distinguishing "not registered" (`hasRegistration` false) from "registered but its factory threw" (a failure).
2. Passes the normalised host (first `x-forwarded-host`/`host` value, lower-cased, `[a-z0-9.-]` plus an optional port, else `null`) only to a provider that declares `varyByHost: true`; every other provider gets `host: null`, and the cache key omits the host.
3. Reads the cache (`container.resolve('cache')`, inside `runWithCacheTenant(tenantId)`), key `tenant-branding:<d|r>:<surface>:<tenantId>:<organizationId>` — `d` for answers of the default provider, `r` for a registered one, so a registration change never serves the other profile's entry — tag `tenant-branding:tenant:<tenantId|global>`, TTL 5 minutes. An entry is re-validated on read and treated as a miss when anything in it no longer validates. Answers that depend on the host are neither read from nor written to the cache.
4. For a registered provider and a request without a host: unless it failed for this tenant and organization within the last 30 seconds (`tenant-branding:provider-failed:<tenantId|global>:<organizationId|->`), calls `resolve()` with a 3-second timeout; synchronous throws, rejections, timeouts and non-object results are failures, each logged and reported (`branding.provider_failed`), and open that window for that tenant and organization only — one organization's failure never gives the tenant's other organizations the fallback brand, and the key space stays bounded because callers pass only verified ids. A registered provider whose DI factory throws opens the same window. A failure for a request that carries a host (a `varyByHost` provider) opens no window, so one host never disables the provider for other hosts and random hosts create no entries; the trade-off is that such a provider is called, bounded by the 3-second timeout, and its failure reported on every host-dependent request. Reports are not sampled or throttled — volume control belongs to the telemetry collector — and a provider that varies by host should cache its own lookups.
5. Validates the result field by field (above); dropped fields are logged at debug level and never turn the result into a failure.
6. Caches every host-less answer, `null` included, per tenant and organization — on the `auth` surface too: login tenants are verified before they reach the resolver, so the key space is bounded by real tenants.
7. On failure of a registered provider falls back to `defaultTenantBrandingProvider` (same timeout) through the default profile's own cache entry, so an outage does not cost a query per request; the default provider is never windowed and its exceptions are reported (`branding.default_provider_failed`); if it fails too, returns `null` (platform default).
8. Never throws. Callers pass only tenant and organization ids from a session or a database lookup.

`GET /api/auth/admin/nav` caches its payload for 30 minutes without the `brand`: the route attaches the brand on every request — from the payload it just built on a miss, from `resolveTenantBranding` (with its own five-minute cache and 30-second failure window) on a hit — so the brand is resolved once per request and a payload cached during a provider failure never pins the fallback brand. The organization passed to the resolver comes from `resolveBrandOrganization`: the scoped organization, else the requested (cookie or query) organization, else the caller's own — each fallback only when the caller's organization access allows it (`scope.allowedIds`, `null` meaning every organization; an explicit all-organizations selection means none) — and only when it belongs to the tenant. A super administrator's home organization while viewing another tenant, an organization the caller may not access, or a client-chosen id never reaches a provider or a cache key. The verified `{ id, name }` is cached per tenant for five minutes under the tenant branding tag, so a nav cache hit or a layout render costs no organization query while it is cached, and an organization change drops it; the chrome reuses it for `currentOrganization`. `invalidateTenantBrandingCache(container, tenantId)` drops the tenant's branding entries and failure windows and the tenant-less entries (`tenant-branding:tenant:global`); for `null` it drops the tenant-less entries. The `directory` module calls it from a `directory.organization.*` subscriber; custom providers call it when their own data changes.

### Wiring (server-side, before first paint) — PR B, except the backend chrome row (PR A)

| Surface | Server entry | Input | What renders |
|---|---|---|---|
| Backend (PR B) | `app/(backend)/backend/layout.tsx` → `resolveBackendTenantBranding({ auth, request: { cookies: cookies() }, host })` | tenant + organization from the same scope resolution as the backend chrome (non-UUID ids dropped) | `<TenantBrandStyle>`, `AppShell` `initialBrand` + `productName` |
| Backend chrome (PR A) | `resolveBackendChromePayload`, and `GET /api/auth/admin/nav` on a cache hit | same scope; the organization verified in the tenant | `brand` (from the resolver, with optional `darkLogo`/`mark`; never stored in the nav cache) |
| Portal (PR B) | `app/(frontend)/layout.tsx` (already resolves `tenantId`/`organizationId` from the URL slug) | tenant + organization of the URL org | `<TenantBrandStyle>`, `PortalLayoutShell` `branding` (client projection) → `PortalShell` `logo`/`darkLogo` |
| Login (PR B) | `app/login/page.tsx` → `resolveLoginTenantBranding({ searchParams, cookies, headers })` | `?tenant=` or the `om_login_tenant` cookie, passed on only when it is the UUID of an existing tenant (positive answers cached 5 minutes and dropped by `directory.tenant.*`); while `tenantBrandingProvider` resolves to the built-in default — which never brands login — there is no lookup, and after the first successful resolution no request container is created until the DI registrars change; no organization | `<TenantBrandStyle>`, `LoginPage` `branding` (client projection) |

- **Product name (PR B).** Backend: the provider's `productName` when its brand (a light logo) is shown, else i18n — the same condition under which the chrome payload carries a `brand`, so first paint and the loaded chrome agree — still suffixed with `DEPLOY_ENV`; next to a branded logo the brand name (`brand.name`) is shown, as before. Login: replaces the `auth.login.brandName` heading and the logo alt fallback. Portal: unchanged (the portal header keeps showing the organization name).
- **Dark logo (PR B).** Both variants are rendered and switched with the `dark:` variant (`dark:hidden` / `hidden dark:inline-block`), so the correct one is visible on first paint — the theme-init script sets `.dark` before the body paints. Neither variant is preloaded when both exist — the server cannot know which one is visible — so both render lazily: React's server renderer preloads every image that is not `loading="lazy"`, and the browser never fetches a lazy image hidden with `display: none`, so only the visible variant loads. With no `dark` logo, markup is identical to today, `priority` included.
- **Backend logo precedence (PR B).** gallery preview logo → backend chrome `brand` once loaded → server `initialBrand` until then → `logo` prop → `/open-mercato.svg`. The server brand and the chrome brand come from the same resolver and the same scope resolution (`resolveBrandOrganization`), so they agree; the sidebar no longer flashes the platform logo before the organization logo.
- **Login tenant (PR B).** The login page keeps its existing tenant handling: the server brands the tenant named by `?tenant=` or the cookie, and a tenant the client restores from local storage alone is not branded until the cookie is written again (by a `?tenant=` visit), exactly as the tenant banner already behaves. A refresh-based reconciliation was dropped as not worth its complexity.

### Brand style emission and the per-browser gallery — PR B

`<TenantBrandStyle brandStyle={branding.style} />` (server component, `@open-mercato/ui/theme/TenantBrandStyle`) renders `<style id="om-tenant-brand-style">` with `brandStyleCss(style)` — selectors `:root:not(.dark)` / `:root.dark` that out-rank `globals.css`/`theme.css`. Nothing is rendered without a style.

**Decision:** the per-browser gallery preview keeps working **on top** of a tenant style, by specificity rather than DOM coordination. `BrandStyleRuntime` is unchanged except that it renders the preview with `brandStyleCss(style, { layer: 'preview' })` (`html:root:not(.dark)`, `html:root.dark`, one element-type selector more than the tenant rules) in its own `<style id="om-brand-style">` in `<head>`. Every token the preview sets therefore wins wherever the tenant element sits and however client navigation mounts, replaces or removes it; an optional accent token the preview leaves unset (`--brand-lime`, `--brand-yellow`, `--brand-violet`, `--brand-violet-foreground`) keeps the tenant's value, exactly as it keeps the theme's value without a tenant style — the preview cannot name the theme default it would restore. Clearing the preview removes only the runtime's element. Neither element touches the other, nothing observes the document, and element ids stay unique. This deliberately departs from the first draft (one shared id, the runtime borrowing the server element and a document-wide `MutationObserver`): the review showed the observer cost and the coupling were unnecessary. Rationale for keeping the preview on top: the gallery is an explicit, local, per-browser preview tool (it already wins over the organization logo); hiding it whenever a tenant has branding would make it useless for exactly the people designing that branding.

## Architecture

```
app layout (server) ──► resolveBackendTenantBranding / resolveLoginTenantBranding / resolveTenantBranding
                            │
                            ▼
              resolveTenantBranding(container, input)   (shared)
               ├─ provider lookup (missing vs failed factory), varyByHost → host or null
               ├─ cache (DI `cache`, tenant-scoped, tagged; never for host-dependent answers)
               ├─ 30 s failure window per verified tenant and organization (registered provider only)
               ├─ tenantBrandingProvider.resolve() with 3 s timeout   (app override or default)
               ├─ field-by-field validation (one logo rule: canonical source or directory organization-logo rule; BrandStyle WCAG rules)
               └─ defaultTenantBrandingProvider fallback  (directory, organization logo)
                            │
                            ▼
   <TenantBrandStyle/> (server <style>)  +  shell props (initialBrand / client branding / logo, darkLogo)
```

### Frontend Architecture Contract — PR B (PR A touches only `AppShell`, see the ledger)

#### 1. Server/Client boundary map

| Route / surface | Server root | Client islands | Data owner | Notes |
|---|---|---|---|---|
| `/backend/**` | `app/(backend)/backend/layout.tsx` | `AppShell` (existing) | `resolveBackendTenantBranding` (server) + `/api/auth/admin/nav` (existing) | Branding resolved in the layout; no new client fetch |
| `/<org>/portal/**` | `app/(frontend)/layout.tsx` | `PortalLayoutShell` → `PortalShell` (existing) | `resolveTenantBranding` (server) | Client receives `logos` only |
| `/login` | `app/login/page.tsx` (reads `searchParams`/`cookies`/`headers`) | `LoginPage` (existing) | `resolveLoginTenantBranding` (server) | Already dynamic: the root layout reads the locale cookie |
| all three | — | `BrandStyleRuntime` (existing, inside `ThemeProvider`) | `localStorage` gallery preview | Only its CSS layer changes |

`TenantBrandStyle` is a server-compatible component without `"use client"`. The style never crosses into client props (`toClientTenantBranding`).

#### 2. `"use client"` ledger

| File | Reason | Imported by | Heavy deps? | Cleanup / hydration risk | Alternative rejected |
|---|---|---|---|---|---|
| `packages/ui/src/theme/BrandStyleRuntime.tsx` (touched, one argument) | reads `localStorage` and appends a `<style>` to `document.head` | `ThemeProvider` | no | unchanged: removes only its own element | server-only: the gallery preview is per-browser |
| `packages/ui/src/backend/AppShell.tsx` (touched) | existing shell interactivity | backend layout | existing | `initialBrand` is a serialisable prop; same markup on server and client | — |
| `packages/ui/src/portal/PortalShell.tsx`, `PortalLayoutShell.tsx` (touched) | existing shell interactivity | portal layout | no | new props are serialisable | — |
| `packages/core/src/modules/auth/frontend/login.tsx` (touched) | existing form state | login page | no | `branding` is a serialisable prop; no new effects | client-side branding fetch (would flash) |

No new `"use client"` files.

#### 3. Client blob guardrail

No new client files; touched client files gain < 60 LOC each.

#### 4. Budgets

| Budget | Default target | Spec value | Measured |
|---|---|---|---|
| Generated backend page-root `"use client"` | 0 new | 0 | `yarn check:client-boundaries`: identical counts on `upstream/develop` and the PR B head (below) |
| Touched client page/root files over 300 LOC | 0 unless justified | `login.tsx` is a pre-existing frontend page root over 300 LOC; this change adds one prop and a logo component, no effects | client page roots over 300 LOC: 127 before and after |
| Heavy browser libraries at page/provider root | 0 | 0 | heavy browser library import hits: 252 before and after |
| Per-route hydration smoke test | required | Playwright: `TC-BRANDING-001` loads `/login?tenant=…`, `/<org-slug>/portal` and `/backend` (light and dark); `TC-DIR-020` loads `/backend` and `/login`; existing `TC-AUTH-053` (backend), and the portal module's `TC-AUTH-064-portal-root-authenticated-shell` and `TC-AUTH-065-portal-login-logo-authenticated-redirect` | see Integration results in the Final Compliance Report |
| Performance evidence | static check + one signal | resolver overhead per request | see below |

`yarn check:client-boundaries` (Windows 11, Node 24):

```
                                              upstream/develop 7187041c2   PR B head (A + B)
scanned TS/TSX files                          12907                        12930 (+23: new modules, tests, template mirror)
top-level "use client" files                  1617                         1617
page-root "use client" files                  287                          287
backend page-root "use client" files          262                          262
frontend page-root "use client" files         25                           25
unallowlisted backend page-root "use client"  262                          262
client page roots over 300 LOC                127                          127
heavy browser library import hits             252                          252
```

Runtime signal — server time `resolveTenantBranding` adds per request, measured with `performance.now()` over 20 000 calls after 500 warm-up calls (`tsx`, Node 24.21, Windows 11, memory cache strategy): default-like provider, cache hit 11.9 µs; full branding, cache hit 26.4 µs; full branding, no cache 31.3 µs; nothing registered 25.0 µs (includes creating a cache service per call). A cache miss with the default provider adds one indexed organization lookup. Login TTFB before/after was not measured; the method to reproduce is `curl -s -o /dev/null -w '%{time_starttransfer}\n' http://localhost:3000/login` ×50 on `upstream/develop` and on this branch, comparing medians.

#### 5. Provider / bootstrap scope

| Provider/bootstrap | Global? | Scope | Why | Exit criteria to narrow |
|---|---|---|---|---|
| `tenantBrandingProvider` / `defaultTenantBrandingProvider` DI keys | request container | scoped | resolved per request in server layouts and the nav API | n/a |
| `ThemeProvider` → `BrandStyleRuntime` | global (existing) | unchanged | gallery preview | n/a |
| `branding_probe` app module (`apps/mercato` only: `MONOREPO_ONLY_MODULE_IDS` in `scripts/template-sync.ts` keeps its source and registration out of the template) | registers only when `OM_TEST_BRANDING_PROBE_MODE=opt-in`, which the integration runner sets (not `OM_INTEGRATION_TEST`, which apps use as a rate-limit switch) | scoped | lets integration specs assert a registered provider end to end; overriding `tenantBrandingProvider` is why it must never reach a standalone app | n/a (test-only) |

#### 6. Test and evidence plan

Every guarantee below is pinned by a test that tries to break it. Unit suites run with Jest; `TC-DIR-019` (default provider, nav payload; PR A), `TC-DIR-020` (default provider, first paint; PR B) and `TC-BRANDING-001` (registered provider, env-gated probe; PR B) are the Playwright integration specs.

## Guarantees

| # | Guarantee | PR | Adversarial inputs | Proving tests |
|---|---|---|---|---|
| G1 | With nothing registered, `/api/auth/admin/nav` `brand` is byte-identical to before for every organization row the directory validator accepts (a blank name is no longer passed on as the brand name), and one organization's logo never affects another's | A | 500-character names, padded names, markup in names, quotes, spaces, 2000-character URLs, `http://`, underscore hosts, trailing-dot hosts, credentials, leading-hyphen labels, empty labels, 70-character labels, `* ! $ ~` in hosts, a tab in the path, attachment logos with a query; a validator-rejected legacy row next to a valid one; blank names | `directory/__tests__/tenantBranding.test.ts` → "default provider through the resolver" (`toStrictEqual` against the previous construction, each URL first checked against `organizationLogoUrlSchema`), "keeps the logo but drops the blank organization name", "two organizations of one tenant"; shared → "keeps a logo with … verbatim", "keeps every directory-accepted organization logo through the default provider …"; `TC-DIR-019` (nav brand from the organization logo; none without a logo); `auth/lib/__tests__/backendChrome.current-organization.test.ts` (unchanged expectations) |
| G2 | With nothing registered, portal and login markup is unchanged; backend markup is unchanged when the organization has no logo | B | no branding, `null` branding | `ui/portal/__tests__/PortalShell.test.tsx` → "keeps the platform logo without branding"; core `login-tenant-branding.test.tsx` → "renders the platform logo and name without branding"; app `layout-tenant-branding.test.tsx` → "renders the platform defaults"; app `login-tenant-branding.test.tsx` → "renders the default login page"; `TC-DIR-020` and `TC-BRANDING-001` (unbranded `/login`) |
| G3 | Branding never breaks a page: a provider that throws (sync or async), rejects, never answers, returns a non-object, or whose DI factory throws degrades to the default provider, then to `null`; an invalid field drops only itself; every source the validator accepts renders — PR A alone included | A (resolver, backend shell), B (pages) | sync throw, rejection, a promise that never settles, a non-object, one invalid logo or style, failing factory, both providers failing, container creation failure, every accepted logo fixture through Next's real `getImgProps` | shared → "falls back …" cases, "keeps a branding with one invalid field …", "returns null when both providers fail", "treats a throwing provider factory as a failure …"; chrome → "falls back to the organization logo when the provider throws"; ui `logo-source-next-image.test.ts` and AppShell chrome-brand cases (PR A); `auth/lib/__tests__/tenantBranding.test.ts` → "… when the container cannot be created" and app `portal-tenant-branding.test.tsx` (PR B) |
| G4 | An invalid brand style is never emitted; valid logos survive it | A (validation), B (emission) | contrast below 4.5:1, unknown tokens, non-hex values | shared → "drops a style failing the WCAG contrast rules and keeps everything else", "keeps a branding with one invalid field …"; `ui/theme/__tests__/tenant-brand-style.test.tsx` → "renders nothing … failing contrast"; existing `brand-style.test.tsx` |
| G5 | A logo is never a script, scheme-relative or malformed source, and every accepted source — the canonical provider sources and every organization logo the directory accepts, from any provider — renders through `next/image` under Next's default image configuration in development and production | A (validation, backend shell), B (other shells) | dropped: `javascript:` in any case, with leading spaces, NUL, tab or newline in the scheme; `vbscript:`; `//`, `/\`, `\\`; `Http://…`; `http:host`; a relative path without a leading slash; a trailing space; `data:text/html`; non-base64 SVG; empty; lone UTF-16 surrogates. Accepted and rendered: `/brand/acme.png?v=3`, `/…#logo`, paths with spaces, attachment URLs with queries, `HTTPS://…?v=2`, quotes, punycode with a port, IPv6, base64 PNG and SVG, and every directory-accepted organization logo | shared → "drops a logo with …", "accepts a logo with … in canonical form", "keeps a logo with … verbatim"; ui `logo-source-next-image.test.ts` (28 accepted fixtures × 7 slot sizes through Next's real `getImgProps` with `localPatterns: [{ pathname: '**', search: '' }]`, and 7 rejected ones including lone surrogates, development and production); AppShell chrome-brand cases `/brand/acme.png?v=3` and `HTTPS://…`; core login → "bypasses the image optimiser for absolute and root-relative logos" (PR B); `TC-BRANDING-001` (raster logos with a query load in a real browser) |
| G6 | No flash: the tenant style and the correct light/dark logo are in the server-rendered HTML | B | dark logo present or absent, mark in compact slots, light and dark colour schemes in a real browser | `tenant-brand-style.test.tsx` → "server-renders the tenant tokens in its own element"; AppShell → "renders the server-resolved initial brand with a dark-mode logo", "shows the brand mark in the collapsed sidebar"; portal and login unit tests (dark classes); app layout tests (style in markup); `TC-BRANDING-001` (style, both logos and product name in the initial `/login`, `/<org-slug>/portal` and `/backend` documents; the matching logo visible and loaded, the other hidden, `--primary` applied, in light and dark mode); `TC-DIR-020` (organization logo in the `/backend` document) |
| G7 | The server brand and the chrome brand agree, and the chrome takes over once loaded | A (shared scope), B (shells) | chrome brand differs from the initial brand | AppShell → "hands over from the initial brand to the backend chrome brand"; `auth/lib/__tests__/tenantBranding.test.ts` → `resolveBrandOrganization` cases |
| G8 | Cache is per tenant, organization and provider profile; invalidation reaches the branding cache and tenant-less entries; failures are not cached as branding; a failing registered provider is skipped for 30 s for the failing tenant and organization only — on the login surface too — and never because of a failure for one host; every failure is reported, the default provider's too, and the default provider is never skipped; corrupted entries are ignored; the nav cache never stores a brand, so the nav brand follows the resolver | A | two tenants, two organizations of one tenant, invalidating the other tenant, tenant-less login entry, flaky and hanging providers, a failing factory, one tenant failing on login while another is requested, one host failing, a default provider failing three times, a registration change, poisoned cache entry, a provider that succeeds, fails and recovers behind a cached nav payload | shared → "falls back … and reports it", "treats a throwing provider factory as a failure reported once per window, serving the cached default", "reports every default provider exception …", "isolates a login provider failure …", "isolates a provider failure to the failing organization …", "never lets one failing host disable … and reports every such failure", "skips a failing registered provider …", "caches per tenant …", "caches a null login answer …", "keeps registered and default answers apart …", "ignores a corrupted cache entry", "invalidates the tenant entries …"; `admin-nav.test.ts` → "follows the branding resolver when a provider succeeds, fails and recovers, never serving a brand from the nav cache"; subscriber tests; `TC-DIR-019` (nav brand on a cache miss and a cache hit, logo change visible without waiting for a TTL); `TC-DIR-020` (the same in the server-rendered document) |
| G9 | Every token the gallery preview sets wins over a tenant style without touching it (optional accents it leaves unset keep the tenant value); element ids stay unique; nothing observes the document — across client navigation | B | preview saved before or after the tenant style mounts, tenant style replaced by another tenant's or removed during a preview | `tenant-brand-style.test.tsx` → "gallery preview over a tenant brand style" (specificity comparison, own elements, navigation, no `MutationObserver`) |
| G10 | Untrusted request input cannot reach a provider unvalidated or grow the caches | A (resolver, nav), B (login) | non-UUID `?tenant=`, unknown tenant UUIDs, array params, cookie fallback, malformed or unknown `om_selected_org`, 200 random hosts, a `varyByHost` provider with 200 random hosts, alternating failing tenants | shared "cache growth under anonymous input" (counting provider calls and cache writes); `admin-nav.test.ts` → "keeps one nav cache entry whatever hosts and brands a host-varying provider answers"; directory → "never queries the database for …"; chrome → "never queries the organization for a malformed selected-organization cookie"; auth lib → "honours the organization access …", "never pairs an organization with a tenant it does not belong to …", "ignores the all-organizations sentinel and never queries malformed ids", login cases (PR B) |
| G11 | The brand is resolved once per request, on nav cache hits and misses alike | A | nav cache miss, nav cache hit, `varyByHost` provider | `admin-nav.test.ts` → "follows the branding resolver …", "keeps one nav cache entry …" |
| G12 | The documented delegation pattern keeps working for organizations with `http://` logos, without failure windows or flapping | A | `varyByHost` provider that brands one host and delegates everything else to `defaultTenantBrandingProvider`, organization logo `http://…` | shared → "keeps http organization logos when a registered provider delegates to the default one as documented" |
| G13 | While nothing can brand login, login keeps today's behaviour: no tenant lookup, no login-tenant cookie write, no refresh | B | `?tenant=` of an existing tenant and a stored tenant with only the built-in provider active | auth lib → "looks nothing up while only the built-in provider is active"; `login-tenant-branding.test.tsx` → "keeps the login tenant behaviour unchanged …" |
| G14 | A tenant change drops its cached login-tenant check, so a deleted tenant stops being branded on login | B | tenant cached as existing, then `directory.tenant.deleted` | auth lib → "stops branding login for a tenant once a tenant event drops its cached existence"; `invalidateTenantBrandingCacheOnTenantChange.test.ts` |
| G15 | The branding probe is inert unless `OM_TEST_BRANDING_PROBE_MODE=opt-in`, and neither its source nor its registration reaches a scaffold | B | nothing set, only `OM_INTEGRATION_TEST`, `true`, `OPT-IN` | `branding_probe/__tests__/di.test.ts`; create-app `template-modules-parity.test.ts` → "monorepo-only modules ship neither their source nor their registration in the template" |
| G16 | A logo variant hidden by the colour scheme is never preloaded; with no dark logo the markup keeps `priority` as today | B | light and dark logos on login and the portal header; light only; no branding | `login-tenant-branding.test.tsx` → "preloads neither logo variant …", "preloads the only logo …"; `PortalShell.test.tsx` → "preloads no header logo variant …", "keeps preloading the header logo …"; `TC-BRANDING-001` (no `<link rel="preload">` for a probe logo in the login, portal and backend documents) |
| G17 | `/login` creates no request container while only the built-in provider is active (after the first successful resolution), and one per render while a registered provider can brand login; a failed container creation or a resolution that found no provider is not remembered. The backend layout keeps one container and one cached organization-scope resolution per document render, separate from the nav request; reusing the nav route's work is not possible across requests, and its cost was not measured | B | five login renders with the built-in provider, a registrar change, a failed creation, a container without providers, three renders with a registered provider | auth lib → "creates a request container once, then none …", "remembers nothing after a failed container creation or a resolution that found no provider", "creates a request container for every login render …" |

Regression evidence: every new or changed unit test was first run against the implementation it guards and failed there — upstream `develop` sources for the original surface; the pre-hardening revision for the first hardening round; `d96bda196` for the first review round; `f3c2b18dd` for the second; the previous PR A head `e15b479c6` for the third review round; and `bce58d876` (PR A) and `f8185c15f` (PR B) for the fourth.

## Data Models

No database changes. Cached values: `{ branding: TenantBranding | null }` (JSON) per surface/tenant/organization and provider profile, 5-minute TTL; `true` failure markers per tenant and organization, 30-second TTL. Both tenant-scoped and tagged `tenant-branding:tenant:<tenantId|global>`. The nav payload cache stores `brand: null`.

## API Contracts

- `GET /api/auth/admin/nav` — `brand` keeps its shape; `brand.logo` may now come from a custom provider, and `brand` gains optional `darkLogo` and `mark` (additive).
- No new routes.

## Migration & Backward Compatibility

All changes are additive; `UPGRADE_NOTES.md` (0.8.0 → 0.8.1) lists the new DI keys, types, optional props, the `BrandStyle` move with its re-export bridge, and the behaviour notes. No deprecation is needed because nothing is removed or renamed.

| Surface | Change | Class |
|---|---|---|
| `@open-mercato/ui/theme/brand-style` exports | unchanged; `BrandStyle`/`brandStyleCss` now re-exported from shared; PR B: new `TENANT_BRAND_STYLE_ELEMENT_ID` | non-breaking |
| `brandStyleCss` | PR B: new optional second argument; default output unchanged | additive |
| Directory `organizationCreateSchema` / `organizationUpdateSchema` `logoUrl` | the same zod union, now imported from `@open-mercato/shared/lib/branding/tenantBranding` (`organizationLogoUrlSchema`) | non-breaking (identical rule) |
| Gallery preview element | PR B: same id and position; selectors gain an `html` prefix | behaviour (wins over tenant styles) |
| `AppShellProps` | PR B: new optional `initialBrand` | additive |
| `PortalShellProps` | PR B: new optional `darkLogo`; `ShellLogo` gains an optional `unoptimized` | additive |
| `PortalLayoutShell` props | PR B: new optional `branding` | additive |
| `LoginPage` | PR B: new optional `branding` prop | additive |
| `BackendChromeBrand` type / nav API response | new optional `darkLogo`, `mark` | additive |
| DI names | new `tenantBrandingProvider`, `defaultTenantBrandingProvider` | additive |
| Event subscribers | new `directory:invalidate-tenant-branding-cache` on `directory.organization.*`; PR B: new `directory:invalidate-tenant-branding-cache-on-tenant-change` on `directory.tenant.*` | additive |
| App modules | PR B: new env-gated `branding_probe` in `apps/mercato` only | additive, inert unless `OM_TEST_BRANDING_PROBE_MODE=opt-in` |
| `/api/auth/admin/nav` cache | stores the payload with `brand: null`; the brand is attached per request (cache key unchanged) | internal (not a contract surface) |

## Risks & Impact Review

| Risk | Severity | Area | Mitigation | Residual |
|---|---|---|---|---|
| A provider throws, hangs or is slow | Medium | every shell render | resolver catches, reports every failure, times out after 3 s, skips the provider for the tenant and organization for 30 s, falls back to the default provider (cached), then to `null`; results cached 5 min | one 3 s delay per tenant and organization per 30 s while a provider hangs; a host-varying provider that hangs costs up to 3 s on every host-dependent request |
| Anonymous requests multiply cache keys (random `?tenant=`, `om_selected_org`, `Host`, `X-Forwarded-Host`) | Medium | cache memory, LRU eviction of unrelated entries | login tenants and unscoped organizations are verified against the database before they reach the resolver; hosts reach providers only with `varyByHost`, and host-dependent results and failures are never cached; the nav cache key never contains a host or a brand | a `varyByHost` provider is called on every request and should cache its own host lookups |
| A provider returns unreadable colours | Medium | accessibility | `BrandStyle` schema (WCAG 4.5:1) enforced server-side; invalid style dropped | none |
| A provider returns a script, scheme-relative, malformed or unloadable logo URL | High | XSS / tracking / SSR crash | one logo rule: canonical sources (root-relative paths, `https://` URLs that parse, base64 image data URLs) or sources the directory accepts for organization logos, well-formed strings only; only the offending logo is dropped; provider logos always render unoptimised, proven against Next's real `getImgProps` | remote URLs are the provider's responsibility; `http://` and credentialed URLs the directory accepts render as before (the shipped CSP blocks `http:` images) |
| Large data-URL logos inflate pages | Low | payload size | data URLs capped at 64 KB, URLs at 8192 characters; style never sent to client components | up to ~8 inlined copies per page for a maximal logo |
| PR B: login tenant id is user input | Low | provider input | only UUIDs of existing tenants are passed; no lookup while the built-in provider is active; known tenants cached 5 minutes | one primary-key lookup per login render with an unknown UUID while a custom provider is registered |
| PR B: with the default provider, backend first paint now shows the organization logo instead of the platform logo until the nav fetch returns | Low | visual | intended (removes the flash); markup is identical for organizations without a logo, and the final state is unchanged | — |
| Memory cache is per process | Low | multi-instance | tag invalidation + 5-minute TTL backstop; Redis recommended for multi-instance | stale branding ≤ TTL on other instances |

`/login` rendering mode is unchanged: the root layout already awaits `detectLocale()`, which reads `cookies()` and `headers()`, so every route — `/login` included — was rendered per request before this change.

## Final Compliance Report

- Tenant isolation: cache keys and tags include `tenantId`; reads/writes run in `runWithCacheTenant`; the default and probe providers filter by tenant; login tenants are verified.
- No direct ORM relationships added; no generated files edited; no new dependencies.
- No hard-coded user-facing strings (alt fallbacks use existing i18n keys or provider data); internal errors carry the `[internal]` prefix.
- DS: no status colours, no arbitrary values; logo switching uses the `dark:` variant on `display` only.
- Template sync: backend layout, frontend layout, login page and their tests mirrored into `packages/create-app/template`; the `branding_probe` module is monorepo-only (`MONOREPO_ONLY_MODULE_IDS` keeps its source and registration out of the template), is listed as app-only in `agent-instruction-budget.test.ts`, and is named in the anti-blueprint oracle and the `om-module-scaffold` skill (`yarn template:sync` passes).
- Integration coverage: PR A — `packages/core/src/modules/directory/__integration__/TC-DIR-019-tenant-branding-default-provider.spec.ts` (default provider: the nav `brand` from the organization's name and logo on a cache miss and a cache hit, a logo change without waiting for a TTL, no brand without a logo). PR B — `packages/core/src/modules/directory/__integration__/TC-DIR-020-tenant-branding-first-paint.spec.ts` (default provider: server-rendered organization logo, invalidation of branding and nav caches, default login) and `apps/mercato/src/modules/branding_probe/__integration__/TC-BRANDING-001-registered-provider.spec.ts` (registered provider: branded login, portal and backend documents, light and dark raster logos with a query string, tenant colours, product name; skips when the probe is not registered, via `GET /api/branding_probe/status`).
- Integration results: `TC-DIR-019` — 2 passed on the ephemeral Docker stack; `TC-DIR-020` and `TC-BRANDING-001` — see the PR description.
- Upgrade notes: `UPGRADE_NOTES.md` → 0.8.0 → 0.8.1 → Tenant branding provider.

## Changelog

### 2026-10-09 (pre-publish)
- Spec checked against each head: items removed in earlier rounds are gone, PR B sections and rows are labelled, the heavy-import count matches the measurement, and the integration results are recorded.

### 2026-10-08 (pre-gate)
- Risk raised to `risk-high`; PR A gains the `TC-DIR-019` integration spec (default provider through the nav payload); PR B's first-paint spec is renumbered `TC-DIR-020`; client-boundary evidence re-measured on `7187041c2`; test citations checked against the code.
- Hidden logo variants render lazily instead of eagerly: an eager image is preloaded by React's server renderer, which the gate run of `TC-BRANDING-001` showed for both probe logos; `TC-BRANDING-001` now asserts no probe logo is preloaded, recognises an enabled portal by its layout instead of by an i18n string the page always carries, and both first-paint specs get a 120 s budget.

### 2026-10-07 (sixth review round)
- A shell's own `logo` prop is back on the existing image-optimiser rule; only provider-supplied logos bypass it, and `logoSourceBypassesImageOptimization` is removed.
- The verified brand organization is cached per tenant under the branding tag, so a nav cache hit costs no organization query.
- A cookie or query organization reaches the resolver only within the caller's organization access.
- PR B: the portal and login shells render provider logos unoptimised through an additive `ShellLogo.unoptimized` flag, a shell's own logo keeps the existing rule, and the backend layout passes the provider's product name only when the brand is shown.

### 2026-10-07 (fifth review round)
- The brand organization is loaded in the tenant whether it is scoped or a fallback, so a super administrator's home organization never reaches a provider paired with another tenant; the chrome reuses the row.
- Provider-supplied logos never go through the image optimiser, while a shell's own `logo` prop keeps its existing rule; the hostname and credential checks the directory rule made redundant are removed.
- `BACKWARD_COMPATIBILITY.md` records the brand semantics, the DI keys and the subscriber ids, the `brandStyleCss` option and the probe opt-in variable.
- PR B: the login refresh reconciliation and the brand-style source attribute are removed and `readLoginTenantId` is module-private; the login container skip is remembered only after a successful resolution.

### 2026-10-07 (fourth review round: simplification)
- One logo rule for every provider (canonical source or the directory organization-logo rule, well-formed strings only) replaces the provenance mark and its cache round trip; blank product names are dropped.
- The nav cache stores no brand: the route attaches the resolver's brand per request, which removes the brand fingerprint, `tenantBrandingVariesByHost` and the `tenantBranding` argument; unscoped organizations are verified before they reach the resolver.
- Every provider failure is reported (the default provider's as `branding.default_provider_failed`), without an in-process throttle; failure windows are per tenant and organization; `null` answers are cached on every host-less key.
- The organization preload is dropped; internal helpers and constants are no longer exported.
- PR B: `/login` skips the request container once it has seen that only the built-in provider is active.

### 2026-10-07 (third review round)
- Validation is field by field: an invalid logo, style or name drops only itself; only a non-object fails.
- Organization logos carry a provenance mark and are validated with the directory's own rule, now shared (`organizationLogoUrlSchema`); G1 holds for every directory-accepted row, one organization never blanks another, and documented delegation keeps `http://` organization logos.
- The default provider is never put behind a failure window or reported as a provider failure; the cache key carries the provider profile; host-dependent failures are never remembered.
- The brand is resolved once per nav request and passed to the chrome payload.
- PR A switches the backend shell to the shared image-loader rule and proves it with Next's `getImgProps`; `brandStyleCss` `layer` and `toClientTenantBranding` move to PR B with their callers; `isSafeTenantBrandingLogoSource` is removed.
- Red-team follow-ups (PR A): host-dependent provider failures are reported once per tenant per window instead of once per request; the default fallback during a failure window is served from its own cache entry.
- PR B: login reconciliation off while nothing can brand login; tenant-existence cache dropped on `directory.tenant.*`; the probe gated by `OM_TEST_BRANDING_PROBE_MODE` and kept out of the template; no preload of hidden logo variants.

### 2026-10-06 (second review round)
- Every accepted logo source renders: root-relative sources with a query or fragment bypass the image optimiser; a red-team test runs every accepted fixture through Next's real `getImgProps` in development and production; the probe uses raster logos with a query.
- Absolute logo URLs must be `https://` with a valid host and no credentials (`http://` stays accepted for the default provider so G1 holds).
- Failure markers keyed by the verified tenant on every surface (a failing login tenant no longer disables login branding for others); a failing provider factory opens the same window, so it is reported once per window.
- Host-dependent results are never cached; the nav cache varies by brand fingerprint instead of host.
- Login skips the tenant lookup while the built-in provider is active and caches known tenants.
- `branding_probe` ships unregistered in the template, with a status route the integration spec skips on; visible-only locators and a portal-enabled precondition in `TC-BRANDING-001`.
- G9 restated precisely for optional accent tokens; split into PR A and PR B.

### 2026-10-06 (review round)
- Bounded cache growth: login tenants verified, hosts only for `varyByHost` providers, no `null` caching for client-controlled keys, nav cache host only on opt-in.
- Logo sources canonicalised (scheme lower-cased, `//` required, root-relative paths only), one shared image-loader rule, data URLs capped at 64 KB, client components receive logos and product name only.
- 30-second failure window per tenant; failing provider factories distinguished from missing registrations; invalidation also drops tenant-less entries; the chrome reuses its organization row; malformed ids never queried.
- Gallery preview layered by specificity in its own element (`om-brand-style`) over the tenant element (`om-tenant-brand-style`); no `MutationObserver`.
- Login banner and branding agree (cookie rewrite + one refresh).
- Env-gated `branding_probe` module and `TC-BRANDING-001`; Frontend Architecture Contract evidence; "Why one PR"; corrected the `/login` rendering-mode claim.

### 2026-10-06
- Hardened after an adversarial pass: scheme-based logo validation, free-length names, a 3-second provider timeout, invalidation of the cached chrome, Guarantees table, integration spec `TC-DIR-019`, `UPGRADE_NOTES.md` entry.

### 2026-10-05
- Spec written and Phase 1 implemented: contract, default provider, cached resolver, backend/portal/login wiring, gallery coexistence, docs.
