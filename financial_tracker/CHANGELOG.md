# Changelog

## 1.0.4

- Fix white/blank page: React crashed on first render because derived
  values (`useMemo`) read `data.savings`/`data.accounts`/etc. while data
  was still loading (`data === null`). All derived computations are now
  null-safe, so the loading screen renders and the app appears once data
  arrives. Verified end-to-end in a headless browser behind a simulated
  Ingress proxy.

## 1.0.3

- Force rebuild release (identical to 1.0.2)

## 1.0.2

- Fix blank page under Home Assistant Ingress: server now injects a `<base>` tag using the `X-Ingress-Path` header so assets and API calls resolve correctly
- Client uses relative API URLs (`./api/...`)

## 1.0.1

- Fix container startup crash (bashio shebang, `map` config format)

## 1.0.0

- Initial add-on release with server-side sync (REST + SSE)
