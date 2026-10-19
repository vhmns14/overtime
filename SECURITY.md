# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository ([direct link](https://github.com/vhmns14/overtime/security/advisories/new)). Do not open a public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with it. If a report needs a token or a running office to reproduce, create a throwaway office on your own deployment; never send real tokens or keys.

You should get a first reply within a week. Fixes land on `master` with a regression test, and the finding is added to [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md).

## Scope

- The Worker and its Durable Objects (`worker/`), including the LLM and GitHub proxies, the page fetcher and previews
- The web app (`src/`), including the viewer link, remote control and pairing
- The Hermes plugin and installer (`integrations/hermes-overtime/`)
- Self-hosting (`Dockerfile`, `docker-compose.yml`, `scripts/selfhost.mjs`)

Known and accepted risks are listed in [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md).

## Supported versions

Only the latest `master` is supported. There are no released versions yet.
