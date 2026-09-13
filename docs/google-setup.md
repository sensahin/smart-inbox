# Google authorization

Dashboard login and mailbox access are separate. You can log in with Cloudflare's email PIN without a Google login client. A mailbox still needs its own Gmail authorization.

## Mailbox OAuth client

1. In Google Cloud, create/select a project owned by the Workspace organization that owns your support mailbox. Enable the Gmail API.
2. In Google Auth Platform, configure Branding, support contact, Audience and Data Access. For organization-only deployment choose Internal where available. See Google's [internal-use exception](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification#internal-use-only). External deployments can have verification requirements; a shared OAuth client cannot be distributed as a substitute for each installation's setup.
3. Add `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/gmail.send`. These support reading, threading, attachments, verified send-as listing, and outgoing mail. Application status changes do not modify Gmail labels.
4. Create an OAuth client of type Web application. Copy the exact Authorized redirect URI from Settings → Connections → Google Workspace. It is `https://YOUR-APP-HOST/api/google/callback`.
5. Download the client JSON. Import it in that Google settings panel and Save. The client secret is encrypted on the server.
6. Choose Connect Google mailbox, sign in as the underlying support mailbox, and approve both permissions and offline access. Saving the JSON alone does not connect the mailbox.
7. Authorize every underlying mailbox separately. Add verified aliases to inbox settings after Google has verified them. An optional deployment `WORKSPACE_DOMAIN` limits which mailbox domains may connect; it does not restrict the owner's login domain.

Smart Inbox starts receiving new mail when a mailbox is connected. Reconnecting resumes synchronization without duplicating saved messages. Test sending, receiving, aliases, and attachments with an address you control.

## Optional Google dashboard login

Create another Web application for basic identity, with `https://YOUR-TEAM.cloudflareaccess.com/cdn-cgi/access/callback`. YOUR-TEAM comes from your Cloudflare Zero Trust organization, not your Worker name. Configure only the owner email in its Access allow policy. See [Deployment](deployment.md).
