# Deployment and owner access

Each installation uses its own Cloudflare account/resources and Google OAuth clients. There is no shared hosted authentication service.

## 1. Private deployment configuration

Run `npm ci`, then `npm run setup`. The installer asks for a Worker name, the exact owner login email, and an optional domain restriction for connected mailboxes. It writes ignored `wrangler.instance.jsonc` with file mode 600. It refuses to overwrite an existing instance. Public `wrangler.jsonc` remains a neutral template with blank owner and Access values.

Store these deployment credentials outside the repository in `~/.config/smart-inbox/cloudflare.env` (directory mode 700, file mode 600):

```dotenv
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-scoped-token
```

Alternatively supply these two environment variables. `SMART_INBOX_CREDENTIALS` selects a different credentials file; `SMART_INBOX_CONFIG` selects a different private Wrangler config. Keep the encryption-key backup beside the selected credentials file, even when using environment variables.

Use an account-scoped Cloudflare token with Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Queues Edit, Workers AI Edit, and Access: Apps and Policies Edit. Automated Access setup also needs Access: Organizations, Identity Providers, and Groups Edit. Permission names in Cloudflare's token UI may vary; use the corresponding account resource groups. No DNS/zone permissions are needed for a workers.dev hostname. Worker scripts permissions include deployment of the bound Durable Object. The token is for local deployment tools only, never a Worker runtime secret.

## 2. Provision and deploy locked

Create your Cloudflare Zero Trust organization first. Its team domain has the form `your-team.cloudflareaccess.com`; it must not be blank. Enable Workers/R2/Queues as needed on your account.

```sh
node scripts/cloudflare.mjs provision
node scripts/cloudflare.mjs wrangler d1 migrations apply DB --remote
npm run build
node scripts/cloudflare.mjs wrangler deploy
```

Provisioning derives resource names and the workers.dev URL from your instance configuration. R2 buckets stay private; preview URLs are disabled. At this stage the Worker is deliberately locked (HTTP 503) because Access is not configured.

## 3. Bootstrap dashboard login

For the simplest login, use Cloudflare's [one-time email PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/):

```sh
node scripts/cloudflare.mjs setup-access
```

The script creates/reuses a PIN identity provider, creates an Access application for the exact app hostname, and allows only the owner email recorded during setup. It records the team's domain and Access audience in the private config, creates an encryption key, and uploads it as a Worker secret. Keep the encryption-key backup safe; it is required to restore encrypted credentials.

If you prefer Google login, create a **separate** Google Web application with `https://YOUR-TEAM.cloudflareaccess.com/cdn-cgi/access/callback`, then run:

```sh
node scripts/cloudflare.mjs setup-access /absolute/path/to/google-login.json
```

This sets Google as the app's login provider. The login JSON never goes into the repository. Do not use the Gmail authorization client for this step.

Deploy the updated config, then open the app URL:

```sh
node scripts/cloudflare.mjs wrangler deploy
```

Check that the hostname redirects unauthenticated visitors to Access. If Cloudflare's workers.dev routing does not redirect automatically, enable Cloudflare Access for the Worker in Workers & Pages → your Worker → Settings → Domains & Routes, and keep the app's owner-only policy. The Worker remains inaccessible without a valid signed token while this is completed. Verify sign-in as owner and denial for a different account; check assets, APIs, attachments, and alternate URLs too.

## 4. Configure after login

Settings → General controls your workspace branding and default time zone. Settings → Connections starts with unconfigured Google, Freemius, Mailchimp, and GitHub cards. Configure only the providers you use. Mailbox signatures, acknowledgement content, hours, sending addresses, and reply status remain per-inbox settings.

AI remains off until you configure its references and explicitly enable it. Outgoing processing and acknowledgements have separate controls under Activity & sending. Owner access and Cloudflare credentials are deployment settings, not editable branding fields.

## Updates

Preserve your private configuration, encryption key, database and provider settings. Run migrations before publishing updated assets/Worker code. For code-only updates where Cron/queue configuration is unchanged, upload and activate a Worker version; check the active version and connection health. Review non-versioned trigger changes separately. Never replace a live configuration with the public template.

## Optional email open tracking

Tracking is off by default. It needs a separate public Worker that serves only a transparent image; do not bypass Cloudflare Access on the dashboard or its API. The tracking endpoint shares the installation's D1 binding and only updates previously registered random tokens. It has no route for reading messages, attachments, customer records, or credentials.

```sh
node scripts/cloudflare.mjs setup-tracking
node scripts/cloudflare.mjs wrangler d1 migrations apply DB --remote
SMART_INBOX_CONFIG=wrangler.instance-tracking.jsonc node scripts/cloudflare.mjs wrangler deploy
npm run deploy
```

Keep the generated tracking instance configuration private. The setup does not enable tracking. Once deployed, use Settings → Activity & sending → Track email opens. Turning it off stops adding pixels and recording new loads. Automated acknowledgements are never tracked.

The first image load is shown as **Customer viewed on** followed by the date and time, an estimate rather than proof of reading. Email privacy tools, scanners and CC/BCC recipients may load the image, and clients that block images may never report an open. Existing emails cannot be tracked retroactively. Pixels stop recording after 90 days; an earlier recorded timestamp remains part of the conversation history. Only the first timestamp is stored; the application does not collect IP addresses, user agents, or per-recipient viewing profiles. Request logging is disabled on the tracking Worker. Cloudflare may process infrastructure metadata under the operator's account settings.

Describe this optional behavior in your support privacy information.
