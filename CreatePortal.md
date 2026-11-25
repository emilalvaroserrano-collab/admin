# Create the MTS portal on a new Zendesk account

Developer checklist. Recreate this portal for a new Zendesk account. Zendesk is the only system of record. The portal is a branded frontend. It does not own customers, tickets, companies, products, orders, payments, or services.

Do not copy the old database and call that a sync. If a screen shows a business record, that record was read from Zendesk. If a button saves a business record, that write landed in Zendesk before the screen says it worked.

## Rules

- [ ] One Zendesk account for every customer and every staff member.
- [ ] The signed-in person never supplies a Zendesk subdomain, token, or client secret.
- [ ] A customer sees only their own user, organization, tickets, orders, and payments.
- [ ] Staff see the records their Zendesk role allows. The portal does not invent a second permission system.
- [ ] Do not send mail through Resend or any other mail API. Zendesk sends the email.
- [ ] Do not mark an action successful when Zendesk rejects it.
- [ ] Do not seed a local catalog, a local ticket, or a local user and hope a later job copies it.
- [ ] A local database may store only the portal session and a short-lived copy of the Zendesk access token. Nothing else.

## 0. Name the new account before writing UI

- [ ] Create the new Zendesk Support account and write down the subdomain. Example: `acme.zendesk.com`.
- [ ] Create one owner agent, `owner@the-company`, and confirm that agent can open Admin Center.
- [ ] Turn on custom objects. Products, orders, payments, and the service catalog are custom object records, not rows in Postgres.
- [ ] Turn on organizations, and allow a user to belong to more than one organization only if the business needs it.
- [ ] Set the brand name to the company name. Customer-facing text says that name, never "Zendesk", except inside Admin Center.
- [ ] Set the help-center and email links back to the portal origin, not `https://{subdomain}.zendesk.com/hc`.

## 1. Make Zendesk the directory

People are Zendesk users. Companies are Zendesk organizations. A person who is not in this Zendesk account cannot sign in.

- [ ] Invite each staff member in Zendesk as an agent or admin. Do not create them first in the portal.
- [ ] Invite each customer in Zendesk as an end user. The portal is invite only. There is no public registration that creates a local user.
- [ ] Put each customer in their organization.
- [ ] Map Zendesk roles to the portal shell:
  - [ ] Owner and admin see the admin portal.
  - [ ] Agent and light agent see the staff tools their groups allow.
  - [ ] End user sees only the customer portal.
- [ ] Add user fields, and read them on the account screen:
  - [ ] `mts_address`, `mts_city`, `mts_region`, `mts_postal`, `mts_country`
  - [ ] `mts_grant_shop` (checkbox) — may open the shop
  - [ ] `mts_grant_services` (checkbox) — may order a service
  - [ ] `mts_grant_invoice` (checkbox) — may choose order now, pay later
  - [ ] `mts_phone`
- [ ] Add organization fields:
  - [ ] `mts_portal_access`
  - [ ] `mts_ordering_enabled`
  - [ ] `mts_approval_required`
- [ ] Confirm an end user created in Admin Center can be found by `GET /api/v2/users/search.json?query=email:person@company`.
- [ ] Confirm a deleted or suspended Zendesk user is refused at the portal sign-in.

## 2. Connect the portal to that account

Create these on the new account. Paste the values into the new environment. Do not reuse the previous account's client id, secret, app id, or webhook secret.

- [ ] Admin Center → Apps and integrations → APIs → OAuth clients.
  - [ ] Name `mts-portal`. Identifier `mts-portal`. Kind: Confidential.
  - [ ] Redirect URL: `https://{portal-host}/api/zendesk/customer/callback`
  - [ ] Also allow `https://{portal-host}/api/zendesk/oauth/callback` for the admin grant.
  - [ ] Scopes: `read`, `write`, `tickets:read`, `tickets:write`, `users:read`, `users:write`, `organizations:read`, `organizations:write`, `custom_objects:read`, `custom_objects:write`.
  - [ ] Save the client secret once.
- [ ] Do not use `client_credentials` unless a live call to `POST /oauth/tokens` returns an access token. This Zendesk product often rejects that grant for a portal client. The working admin path is the authorization-code grant while the owner is signed in to Zendesk.
- [ ] Admin Center → Apps and integrations → APIs → API tokens, only if the account still allows them. Email plus token is the Support API fallback. OAuth is the default.
- [ ] Admin Center → Apps and integrations → Conversations API. Create one key.
  - [ ] Save App ID, Key ID, and Secret.
  - [ ] This key is how the portal files a ticket or an order email when the Support token is missing. It is not a substitute for reading the catalog.
- [ ] Admin Center → Account → Security → End user authentication.
  - [ ] Keep Zendesk email and password for invited users.
  - [ ] Add a JWT signing key if the widget or the CSR agent needs a signed end user. Save the key id and secret.
  - [ ] Google and Microsoft are optional. If you add them, the redirect is `https://{portal-host}/production/signin`, and Zendesk still has to already know that email.
- [ ] Environment:

```
ZENDESK_SUBDOMAIN=
ZENDESK_EMAIL=
ZENDESK_API_TOKEN=
ZENDESK_OAUTH_CLIENT_ID=mts-portal
ZENDESK_OAUTH_CLIENT_SECRET=
ZENDESK_OAUTH_SCOPES=read write
ZENDESK_OAUTH_TOKEN_URL=https://{subdomain}.zendesk.com/oauth/tokens
ZENDESK_CONVERSATIONS_APP_ID=
ZENDESK_CONVERSATIONS_KEY_ID=
ZENDESK_CONVERSATIONS_SECRET=
ZENDESK_END_USER_JWT_KEY_ID=
ZENDESK_END_USER_JWT_SECRET=
ZENDESK_WEBHOOK_ID=
ZENDESK_WEBHOOK_SECRET=
ZENDESK_EVENT_WEBHOOK_ID=
ZENDESK_EVENT_WEBHOOK_SECRET=
```

- [ ] `GET /api/v2/users/me.json` with the admin token returns the owner, role `admin`.
- [ ] A 401 or `invalid_client` stops the setup. Do not continue by writing to a local table.

## 3. Create the Zendesk objects

Run these once against the new account, as the admin. The portal reads the records afterwards. It does not create a parallel table and backfill later.

### Ticket fields and forms

- [ ] Read `GET /api/v2/ticket_fields.json` before adding anything. Reuse Subject, Description, and Priority.
- [ ] Customer-visible fields are only fields Zendesk marks visible and editable for end users.
- [ ] Add a portal justification field only if the built-in Business Justification field is locked to agents. Do not pretend a locked field was updated.
- [ ] Build one ticket form for support, one for a service order, and one for a complaint. Each form lists only the fields that form needs.
- [ ] Status, assignee, group, and custom status stay agent fields. The customer portal shows them and does not write them.
- [ ] Lookup fields (asset, service catalog lookup) render only when the portal can search the related record and store the Zendesk id. A typed name is not an id.

### Custom objects

Create these keys. Field types are the Zendesk types.

- [ ] `mts_product` — Product
  - [ ] `sku` text, unique
  - [ ] `category` text
  - [ ] `description` textarea
  - [ ] `specs` textarea
  - [ ] `price_cents` integer
  - [ ] `stock` integer
  - [ ] `available` text (`true` or `false`)
  - [ ] `image_url` textarea, the main image
  - [ ] `images` textarea, one URL per line, first line is the main image
  - [ ] `visibility` text (`all` or a role key)
- [ ] `mts_order` — Order
  - [ ] `number` text, shown as `MT-{id}`
  - [ ] `email` text, the requester
  - [ ] `user_id` text, the Zendesk user id
  - [ ] `organization_id` text
  - [ ] `status` text (`open`, `paid`, `fulfilled`, `cancelled`)
  - [ ] `payment_status` text (`unpaid`, `paid`, `invoiced`, `refunded`)
  - [ ] `payment_method` text (`card`, `invoice`)
  - [ ] `shipment_status` text (`unfulfilled`, `shipped`, `delivered`)
  - [ ] `tracking_carrier` text
  - [ ] `tracking_number` text
  - [ ] `total_cents` integer
  - [ ] `ship_name` text
  - [ ] `ship_address` textarea
  - [ ] `items` textarea, JSON array of `{ sku, name, quantity, unit_price_cents }`
- [ ] `mts_payment` — Payment
  - [ ] `order_number` text
  - [ ] `user_id` text
  - [ ] `status` text
  - [ ] `method` text
  - [ ] `amount_cents` integer
  - [ ] `reference` text, the processor id
- [ ] `mts_service` — Service catalog
  - [ ] `category` text
  - [ ] `name` text
  - [ ] `summary` textarea
  - [ ] `price_cents` integer, `0` when the price is quoted
  - [ ] `unit` text (`month`, `drop`, `each`)
  - [ ] `active` text
- [ ] Seed `mts_service` from the live offer, not from memory:
  - [ ] Managed IT: Help Desk, Server and Network Management, Backup and Recovery, Cybersecurity and Compliance, 24-Hour System Mentoring, Vendor Management, Virtual CIO, Business Continuity, Business Antivirus and Endpoint Security
  - [ ] Cloud: Application Hosting, Cloud Migration, Desktop as a Service, Infrastructure as a Service, Colocation, Virtual Server Hosting, Virtualization Support, VoIP Phone System
  - [ ] Projects: IT Consulting, Migration and Deployment, Wi-Fi, Mobility, Performance and Security Audits, Free IT Health Check, Structured Data Cabling, Office Move, Domain and Business Email
  - [ ] Business apps: Google Workspace, Active Directory, Microsoft 365, SharePoint, Azure, Teams, Intune, Windows Management
  - [ ] Lines: internet (Spectrum, cable, AT&T fiber, Frontier fiber, fixed wireless), wiring at a published per-drop price, VoIP extension with the monthly add-on called out before confirm, desk phone as a shop SKU, physical fax, eFax with a recipient mailbox
- [ ] Seed `mts_product` from the admin catalog that should be for sale. If it is not a Zendesk record, it is not for sale.
- [ ] `GET /api/v2/custom_objects/mts_product/records` returns those products before any customer opens the shop.

### What becomes a ticket

- [ ] A support request is a ticket. Store the Zendesk ticket id. Do not store a second status.
- [ ] A complaint is a ticket on the complaint form.
- [ ] A service order is a ticket on the service form, tagged with the `mts_service` record id.
- [ ] A public comment is the only customer-visible reply. The author shown in the portal is "MTS Support" when the author is an agent.

## 4. Webhooks back into the portal

The portal does not poll as the source of truth. Zendesk pushes changes. The portal refreshes its screen from the same API.

- [ ] Create a webhook named `MTS portal events`.
  - [ ] Endpoint `https://{portal-host}/api/zendesk/webhook`
  - [ ] Method POST, format JSON, authentication None.
  - [ ] Save the signing secret. The portal checks `X-Zendesk-Webhook-Signature` as base64 HMAC-SHA256 of `{timestamp}{raw body}`.
- [ ] Subscribe at least:
  - [ ] `zen:event-type:ticket.created`
  - [ ] `zen:event-type:ticket.status_changed`
  - [ ] `zen:event-type:ticket.comment_added`
  - [ ] `zen:event-type:user.created`
  - [ ] `zen:event-type:organization.created`
  - [ ] `zen:event-type:organization.updated`
- [ ] A ticket event updates the open portal ticket view for that requester only.
- [ ] A user event lets that invited email sign in. No local user row is required.
- [ ] An organization event appears on the admin companies screen.
- [ ] Reject a body with a bad signature with 401.
- [ ] Answer 200 only after the event was applied. A 200 that ignored the body is a bug.
- [ ] Send one signed test for a ticket, a user, and an organization before building the rest of the UI.

## 5. Build the app shell

Use the same stack. Do not start a second framework.

- [ ] React 19, TypeScript, TanStack Start, TanStack Router, TanStack Query, Tailwind.
- [ ] Routes, and nothing under the old `/portal` tree:
  - [ ] `/production/signin` is the only sign-in page.
  - [ ] `/production` redirects there.
  - [ ] `/production/user-portal` is the customer home after sign-in.
  - [ ] `/production/admin-portal` is the staff home, and only for an agent, admin, or owner.
- [ ] Unsigned visitors who open a portal URL go to sign-in.
- [ ] The sign-in page says the portal is invite only. It does not mention the Zendesk product name.
- [ ] Forgot password calls Zendesk to send the reset. If the email is not a user in this account, the page says it is not invited. It does not open the Zendesk agent console.
- [ ] After sign-in, load `GET /api/v2/users/me.json` and keep that user as the session profile.
- [ ] Header shows the person's name from Zendesk. It does not show a hard-coded "User 1".
- [ ] An admin, owner, or agent sees an Admin entry. An end user does not.
- [ ] Mobile keeps a sticky header and a five-icon bottom bar. Desktop does not show the bottom bar.
- [ ] Customer bar, left to right: Home, Shop, Tickets, Orders, Account.
- [ ] Desktop pages share one content width, with equal left and right margins.

## 6. Customer portal, each screen reading Zendesk

- [ ] Home (`/production/user-portal`)
  - [ ] Open ticket count, unread agent replies, open orders. All three are Zendesk queries for this user.
  - [ ] Notification bell shows the number of ticket comments the customer has not opened.
- [ ] Tickets
  - [ ] List `GET /api/v2/users/{id}/tickets/requested.json` or the requests API.
  - [ ] Create posts a ticket with the end-user email as requester. The returned id is the id on screen.
  - [ ] Reply posts a public comment. The comment is visible only after Zendesk accepts it.
  - [ ] Status on the list is the Zendesk status, not a local enum that can drift.
- [ ] Shop
  - [ ] Grid is `mts_product` where `available` is true and stock is above zero.
  - [ ] Product page loads by SKU from Zendesk. The wrong product must not reuse another record's title.
  - [ ] Images fit the card. A tap opens the image.
  - [ ] Add to cart writes a draft `mts_order` with status `cart`, or one cart custom object `mts_cart` for this user. The cart icon opens that list.
  - [ ] A line in the cart opens checkout for that line.
- [ ] Checkout
  - [ ] Refuses a SKU that Zendesk no longer marks available, or whose stock is zero. The error names that product.
  - [ ] Card payment is a capture form for the configured processor. The paid result is an `mts_payment` record and the order `payment_status` becomes `paid`.
  - [ ] Order now, pay later is shown only when `mts_grant_invoice` is true. That order is `payment_status=invoiced`.
  - [ ] Place order writes `mts_order` first. Then Zendesk emails the requester with the invoice text and the PDF attached as a public reply.
- [ ] Orders
  - [ ] List is this user's `mts_order` records.
  - [ ] Detail shows lines, totals, payment, shipment, tracking, and the product image from `mts_product`.
  - [ ] Pay now opens billing or the processor the order already uses.
- [ ] Services
  - [ ] List is `mts_service`.
  - [ ] A request creates a ticket on the service form and stores the service record id on the ticket.
  - [ ] A VoIP extension shows the monthly add-on and requires a confirm before the ticket is filed.
  - [ ] A new extension can add the desk-phone SKU to the cart. It does not invent a phone that is not in `mts_product`.
- [ ] Billing
  - [ ] Shows the user fields for the address.
  - [ ] Shows `mts_payment` rows for this user.
  - [ ] Saving the address is `PUT /api/v2/users/{id}.json` with those user fields.
- [ ] Account
  - [ ] Name, email, phone, and organization come from the Zendesk user. Email is not editable into a different Zendesk identity without an admin.
- [ ] Complaints
  - [ ] Same as a ticket, complaint form, tagged `complaint`.
- [ ] Notifications
  - [ ] A ticket comment webhook is the unread item. Opening it marks the Zendesk comment seen. There is no second notification table.

## 7. Admin portal, the agent workspace

Staff actions use the admin token or the authorization-code grant. They do not use the customer's session to edit another customer.

- [ ] Sidebar is sticky on desktop and does not scroll away with the page. Header and sidebar header are the same height. The sidebar collapses.
- [ ] Counts on Tickets, People, Companies, Catalog, and Orders are Zendesk counts, loaded once per page open.
- [ ] Tickets: search, open, public reply, solve. A reply is a ticket comment. Solving sets the Zendesk status.
- [ ] People: `GET /api/v2/users.json`. Invite creates the Zendesk user. The portal does not keep a person Zendesk does not have.
- [ ] Companies: `GET /api/v2/organizations.json`. Create and rename go to that API.
- [ ] Catalog: list, grid, and a Shopify-style create form. Save creates or updates `mts_product`, including several images and one main image. The shop reads the same record.
- [ ] Orders: list and detail from `mts_order`. An admin may edit status, shipment, and tracking. A delete is a Zendesk record delete, limited to the owner role.
- [ ] Services: edit `mts_service` records. Deactivating a record removes it from the customer list.
- [ ] Payments: list `mts_payment`. The processor webhook updates that record. It does not update a local order only.
- [ ] Integrations: show the connected subdomain, whether `users/me` is an admin, and the last webhook delivery. Do not show a secret after it is saved.
- [ ] Roles: changing shop, service, or invoice access writes the user fields in Zendesk.
- [ ] Notifications: the staff list is ticket events assigned to them or to their groups.
- [ ] Agent page: the staff assistant may create and update tickets, users, and orders only through the same Zendesk calls the staff member is allowed to make. A tool failure is said out loud. It is not described as done.

## 8. Mail is a Zendesk trigger

The portal does not send mail. It files one ticket. Zendesk's trigger mails the requester. Do these steps in Admin Center before the first order.

1. Sign in as the account owner.
2. Open **Admin Center → Objects and rules → Business rules → Triggers**.
3. Click **Add trigger**. Name it `MTS order confirmation`. Leave it **Active**.
4. Meet **ALL** of these conditions:
   - Ticket → Is → Created
   - Tags → Contains at least one of the following → `order`
5. Action: **Notify by → Email user**
   - Recipient: `(requester)`
   - Subject: `{{ticket.title}}`
   - Body: `{{ticket.latest_comment}}`
6. Save. Add a second trigger named `MTS order update`.
7. Meet **ALL** of these conditions:
   - Ticket → Is → Updated
   - Tags → Contains at least one of the following → `order`
   - Comment → Is → Public
8. Use the same email action. This covers shipment and payment notes. It does not send the invoice a second time.
9. Do not add a Channel condition. Portal tickets are created by the API. A Channel rule skips them.
10. Open the built-in trigger **Notify requester and CCs of received request**. If it is active and does not restrict the channel, turn it off or exclude the `order` tag. Otherwise the customer receives two emails.
11. Place a test order. On the ticket, open **Events**. Confirm **Email notification sent to** the requester. The portal marks the email sent only after that event is present.

What the portal writes on that ticket:

- [ ] Requester name and email are the customer on the order. An admin order copies the selected person's email. A shop or portal order uses the signed-in customer.
- [ ] The first comment is public and is the invoice, with the PDF attached.
- [ ] The ticket is tagged `order` and `invoice`.
- [ ] A later shipment or payment note is a new public comment on the same ticket, not a second ticket.
- [ ] If the audit has no Notification event, the order email stays failed and the error is stored. It is not marked sent.
- [ ] A confirmation that already notified the requester is not sent again.

## 9. Payments

- [ ] Card checkout calls the processor from the server.
- [ ] The browser never sees the processor secret.
- [ ] On success, write `mts_payment` and set the order `payment_status` in Zendesk.
- [ ] On failure, leave the order unpaid and show the processor message.
- [ ] The webhook from the processor is verified with its signing secret, then writes the same Zendesk records.
- [ ] Sandbox credentials are allowed only while `ALTERNATIVE_ENV=sandbox`. Live mode refuses the sandbox host.

## 10. The CSR agent

- [ ] The floating agent is a front end on the Zendesk conversation for the signed-in user.
- [ ] It may place a ticket, a service request, or an order only by calling the same server functions the portal uses.
- [ ] Those functions re-check the user's Zendesk grants. The agent is not a hidden superuser on the customer portal.
- [ ] A staff agent on the admin portal uses the staff member's own Zendesk rights.
- [ ] Every mutation returns the Zendesk id. The agent repeats that id. If there is no id, it says the action did not happen.

## 11. Prove it on the new account

Do these in order on an empty new account. Stop at the first failure.

- [ ] Owner signs in and `users/me` is an admin.
- [ ] An email that is not in Zendesk is rejected.
- [ ] Inviting a new end user in Zendesk, then signing in as that user, lands on `/production/user-portal`.
- [ ] That user files a ticket and the same id appears in Zendesk. An agent reply in Zendesk appears in the portal without a manual reload of a local table.
- [ ] A product created in the admin catalog is a `mts_product` record and is the product the shop shows for that SKU.
- [ ] Checkout of a second product does not display the first product's name.
- [ ] Checkout of a product with stock `0` is refused.
- [ ] A paid order writes `mts_order` and `mts_payment`, and the customer receives the Zendesk email with the PDF.
- [ ] An invoiced order is possible only for a user with `mts_grant_invoice`.
- [ ] A service request is a ticket, and the service name matches the `mts_service` record.
- [ ] An organization webhook creates nothing in a local company table, and the admin companies screen shows the Zendesk organization.
- [ ] Suspending the user in Zendesk blocks the next portal request.

## 12. Leave behind

Do not port these as sources of truth. They are the old cache.

- [ ] `products`, `product_images`, `orders`, `order_items`
- [ ] `tickets`, `ticket_comments`
- [ ] `organizations`, `customer_users`, `shop_customers`
- [ ] `service_catalog`, `service_requests`
- [ ] `notifications`, `outbound_emails`
- [ ] Any job that "syncs Zendesk into Postgres" and then lets the page read Postgres

The new portal can keep a session table. After that, Zendesk is the database.
