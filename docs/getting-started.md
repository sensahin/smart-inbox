# Getting started

Complete [deployment](deployment.md), then sign in with your owner account.

## Connect an inbox

Open **Settings → Connections → Google Workspace** and follow the [Google setup guide](google-setup.md). Smart Inbox starts receiving new mail when you connect a mailbox. Add other mailboxes or verified sending aliases as needed.

Send a test email to your connected address. It should appear in Open, and the sender should appear in Contacts. Mail synchronization runs in the background, even when the dashboard is closed.

## Set up replies

In **Settings → Inboxes**, choose your sending name, signature, and default reply status. Under **Activity & sending**, enable outgoing messages when you are ready to reply.

The Send button submits your reply through Gmail. A successful send applies your chosen status; a customer response reopens the conversation. Drafts are saved automatically as you write.

To send an acknowledgement when a new conversation arrives, set its message and schedule in the inbox settings, then enable **Automatic acknowledgements**. These messages do not close conversations.

## Find customers and conversations

Use Open, Waiting, Closed, and Trash to manage your inbox. Search finds names, email addresses, subjects, ticket numbers, and message text.

Contacts are saved automatically and shared across inboxes. Search by name or email, filter by inbox, or sort by conversation count and last activity. Open a contact to see their conversation history, including conversations in Trash.

## Add optional connections

Configure Freemius for customer license information, Mailchimp for audience membership, and GitHub for repository references. Each connection is optional.

For AI assistance, follow [AI draft setup](ai-drafts.md). AI prepares drafts for review. It does not send replies.

Email open tracking is optional and starts off. See [tracking setup](deployment.md#optional-email-open-tracking).

## Check operation

Use **Settings → Activity & sending** to check mailbox synchronization, failed sends, and the latest backup. Test replies, attachments, and sender aliases with an address you control. Follow [recovery](recovery.md) for a failed send or a database restore.
