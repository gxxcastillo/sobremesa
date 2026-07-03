# Identity, Auth & Interfaces

This file defines the identity model, auth flows, API surface, and Studio routes at a behavioral level.
Tables are described in [`data-model.md`](./data-model.md).

## 6.1 Identity Model

Sobremesa keeps four concepts separate:

| Concept     | Scope  | Meaning                                                 |
| ----------- | ------ | ------------------------------------------------------- |
| Identity    | global | One chat-provider account, e.g. Telegram user id.       |
| User        | global | Web/session account; may have multiple identities.      |
| Person      | family | Genealogical person in a family tree.                   |
| Participant | family | A person who has actually appeared in the conversation. |

The link chain is:

```
Telegram message → identity → family_access → person → relationships
```

`family_access` is the per-family authorization record. It carries role (`viewer|member|admin`),
status, optional claimed `personId`, and grant source.

## 6.2 Auth

Supported flows:

- **Telegram Login Widget:** verifies Telegram HMAC and payload age, then creates/updates user and
  identity and issues a JWT.
- **Access pass:** `/sobremesa studio-link` creates a short-lived single-use token whose hash is stored
  in `access_passes`. Redeeming it grants `family_access` and issues a JWT.
- **Admin/dev login:** `/api/auth/login` logs in by Telegram user id; production requires
  `ADMIN_LOGIN_SECRET`.

Sessions are stateless JWTs signed with `ACCESS_PASS_SECRET` and stored by Studio in localStorage.
Identity timezone is editable from Studio and used for date interpretation.

Authorization is enforced by Elysia guards plus database RLS. Family role order is
`viewer < member < admin`; `super_admin` is global.

## 6.3 API Surface

The API app (`apps/api`) is Elysia + Bun with Swagger and CORS. It uses the Supabase service-role
client behind authenticated routes.

Endpoint groups:

- **Public:** health and aggregate public stats.
- **Auth:** Telegram login, access-pass redemption, current user/families, timezone update, logout,
  admin/dev login.
- **Family:** family summaries, placeholder narrative/book generation, queue stats, admin reprocess,
  dead-letter queue listing and requeue.
- **Identity:** view/claim/unclaim current person; list/create/update people for self-identification.
- **Admin:** allowed-chat management and super-admin family deletion.
- **Import:** duplicate check, start/poll/cancel/resume WhatsApp import, run Intern review, override
  decisions, submit selected messages to Scribe.

## 6.4 Studio

Studio (`apps/studio`) is a Solid.js SPA backed by `StudioApiClient`. Auth state lives in
`AuthContext`; the JWT is kept in `localStorage`.

Main routes:

- `/login`: Telegram login and public stats.
- `/pass/:token`: access-pass redemption.
- `/select-family`: choose an accessible family.
- `/family/:familyId`: dashboard and super-admin allowed-chat tools.
- `/family/:familyId/identity`: claim/create/edit the current user's person record.
- `/settings`: account settings, currently timezone.
- `/import/whatsapp`: super-admin WhatsApp import wizard.

## 6.5 Chat Admins

Telegram admin status is cached in `chat_admins` by `AdminSyncHandler`. It gates family registration,
chat admin commands, and access-pass role assignment. Registration also requires the chat to be in
`allowed_chats`.
