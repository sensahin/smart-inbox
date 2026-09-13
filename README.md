# Smart Inbox

A private, self-hosted email support inbox for one owner. React and TypeScript on Cloudflare Workers, D1, private R2, Queues, and Workers AI.

- Multiple Gmail / Google Workspace inboxes and verified sending aliases.
- Open, Waiting, Closed, recoverable Trash, search, saved replies, attachments, and conflict-protected drafts.
- Automatically saved contacts with search, inbox filters, and conversation history.
- Optional read-only Freemius and Mailchimp customer details.
- Optional AI research using your documentation, GitHub repository, and earlier replies. AI writes drafts; it cannot send them.
- Configurable workspace name, uploaded logo, documentation link, product subject formatting, and inbox identities.
- Optional email open estimates, disabled by default and controlled in Settings.

New installations contain no mailboxes, credentials, customer records, documentation sources, or GitHub repositories. AI, outgoing processing, and acknowledgements start disabled. Freemius and Mailchimp remain unconfigured until the owner adds credentials.

## Installation and first login

Start with [Deployment](docs/deployment.md). The owner email is configured on your machine **before** deployment. Cloudflare Access verifies that email using an email PIN or your own Google login application. The Worker also checks the signed Access token and owner address on every request, including static assets. Missing owner or Access configuration leaves the deployment locked.

After signing in, configure integrations under Settings → Connections. Connecting Gmail authorizes a support mailbox; it does not grant access to the dashboard. There is no public registration or first-visitor administrator flow.

## Local development

Requires a current Node.js version supported by Vite and Wrangler (Node 22.12+ or 24+), npm, and a Cloudflare account for deployment.

```sh
npm ci
npm run db:local
npm run build
npm run dev:api
# In a second terminal:
npm run dev
```

Open `http://127.0.0.1:5173`. The local API enables a development owner only on loopback hostnames. It removes the Workers AI binding, so local tests cannot incur inference charges. Never enable development authentication in a deployed configuration. Stop both commands with Ctrl-C when finished.

Optional fictional demo data: `npm run seed:local`. This command writes only local storage and does not configure provider credentials. For local credential-form testing, put a generated 32-byte base64 `ENCRYPTION_KEY` in the ignored `.wrangler/.dev.vars`; production uses a Worker secret.

```sh
npm run check
npm test
npm run build
```

## Operations

- [Google mailbox authorization](docs/google-setup.md)
- [AI draft setup and limits](docs/ai-drafts.md)
- [Getting started](docs/getting-started.md)
- [Backups and recovery](docs/recovery.md)
- [Testing](docs/testing.md)

Keep deployment credentials, `wrangler.instance.jsonc`, local `.wrangler` state, database exports, and provider secrets private. Public source must be exported from the explicit file list in `scripts/export-source.mjs`, not by uploading the working directory.

## License

Smart Inbox is available under the [MIT License](LICENSE). Dependencies retain their own licenses; `node_modules` and compiled bundles are not included in this source repository. Generated Cloudflare runtime types retain their Apache 2.0 notices; see [third-party notices](docs/third-party-notices.md).

This is an early release for a single owner. Follow [Getting started](docs/getting-started.md) to connect your first inbox.
