# Testing

Install dependencies with `npm ci`, then run:

```sh
npm test
npm run build
npm run release:check
```

Tests use isolated local D1/R2 storage and mocked email and integration providers. They cover synchronization, threading, send retries, status transitions, HTML sanitization, attachments, drafts, contacts, provider responses, and AI eligibility and reference selection. Authentication tests check protected routes, rejected origins, and missing deployment configuration.

For browser testing, start the local servers using the [README instructions](../README.md#local-development). `npm run seed:local` adds fictional contacts and conversations. Check navigation, search, sorting, pagination, drafts, and settings at desktop and mobile widths. Stop the servers when finished.

Before using a deployment for support, test sign-in, receiving and replying with mailboxes you control. Verify the configured aliases and attachments, and check connection and backup health. Local tests do not validate your Cloudflare routing or external provider credentials. See [Getting started](getting-started.md) and [Recovery](recovery.md).
