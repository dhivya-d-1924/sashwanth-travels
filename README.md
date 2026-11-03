# Sashwanth Travels — booking website with AI agent

A responsive booking website for Sashwanth Travels. **Saarathi**, the AI agent, takes trip requests by voice or text, checks real vehicles, rates and the calendar, and prepares a booking for the customer to confirm. Customers, drivers, managers and the owner each sign in and see what their role allows. Drivers post photos from the road (pickup, odometer, receipts) that customers see instantly, and the odometer readings produce the final bill.

The same page runs in two places:

| | Self-hosted (this project) | Inside Claude (published artifact) |
|---|---|---|
| Sign-in | Email or mobile + password | Claude account |
| Data, rules, photos | This server (`data/`) | Claude's artifact storage |
| AI agent | Your Claude API key | Each viewer's Claude account |
| Who can visit | Anyone with the address | People you share it with |

`src/site.html` is the single source for both.

## Design

Dusk-highway look (navy to marigold), Big Shoulders Display headings, Hind Madurai body text (supports Tamil). Motion and hover effects:

- Hero: animated night highway (palms, gopurams, headlights) that follows the mouse; text and agent panel animate in.
- Route ticker that pauses on hover.
- 3D rotating destination carousel built from the route table; auto-rotates, pauses on hover/focus, swipe on phones, arrow keys, dots. Uses Live gallery photos when the owner uploads them.
- Fleet flip cards: hover (or tap on phones) turns the card to show seats, rate, minimum km, bata and a "Book this vehicle" button that preselects it in the booking form.
- Route stop tiles zoom and rotate on hover; how-it-works cards lift and light up.
- Trip-photo fan that spreads on hover, or automatically when scrolled into view on phones.
- Call-to-action band with a rotating text badge.
- Everything respects "reduce motion" settings. Tested with no sideways scrolling at 320, 375, 414, 768, 1024, 1280, 1440 and 1920 px.

The "at a glance" strip shows only real figures from the site's data; the owner can add years in business and trips completed under Business setup.

## Run it

Requires Node.js 20.12 or newer.

```bash
npm install
cp .env.example .env     # set OWNER_EMAIL, OWNER_PHONE, OWNER_PASSWORD, ANTHROPIC_API_KEY
npm start                # http://localhost:3000
npm test                 # 31 tests: access rules, accounts, sessions, photos, agent proxy
```

The owner account is created on first start from `.env`. Without `ANTHROPIC_API_KEY` everything works except the agent, which shows as offline; customers use the booking form.

## First-time setup (owner)

The real business details were not available (the Expo build link needs a team login and no public listing was found), so the site starts with **clearly labelled sample data** and refuses booking requests until the owner publishes real details.

1. Sign in under **My account** with the owner email/mobile and password.
2. **Fleet & rates**: real vehicles, seats, units, ₹/km, minimum km/day, driver bata, and a real photo of each.
3. **Routes**: common routes with one-way road km and stops.
4. **Business setup**: phone, WhatsApp, email, address, hours, UPI / bank details, advance %, GST, night charge, cancellation cutoff, max unpaid requests, policies → **Save & publish**. Booking opens here.
5. **Team & roles**: drivers and managers create an account on the site, then you find them and assign a role.
6. **Live gallery**: upload real photos of vehicles and destinations.
7. **Launch readiness** lists anything still missing.

## Roles

| Role | Can do |
|---|---|
| Guest | Browse fleet, routes, fares, gallery; chat with the agent |
| Customer | Book, pay (UTR + screenshot), track trips live, see driver and trip photos, cancel within the cutoff, message the owner |
| Driver | Trip sheets for trips assigned to them: pickup photo, start odometer, toll/parking receipts, end odometer |
| Manager | Everything below the owner: bookings, trip sheets, fleet, rates, routes, calendar, gallery, messages |
| Owner | Everything, plus the team, blocking customers and resetting passwords |

**Enforced by the server** (see `server/rules.js`, tested in `test/rules.test.js`):
- Customers can only read and write their own requests.
- Booking status, locked prices, driver assignments and trip photos are staff-only writes; each customer can read their own.
- Customer verification and blocking records are staff-only.
- Only the owner can change the team.
- Blocked customers can't send requests.
- Customers' payment screenshots are visible only to them and staff.

**Enforced by the page:** the split between Manager and Driver. Both are staff to the server, so add only people you trust.

## Business rules

- **Estimate:** chargeable km = max(running km, minimum km/day × days); fare = chargeable km × ₹/km + driver bata × days + night charge × (days − 1) + GST. Advance = advance % rounded up to ₹10.
- **Price lock:** confirming locks the rate card at that moment; later rate changes don't affect the booking.
- **Final bill:** actual km = end − start odometer (both photographed), priced with the locked rate, plus photographed receipts, minus the advance paid.
- **Availability:** units minus overlapping confirmed bookings and owner blocks. Confirmed trips block a unit; ending or cancelling frees it.
- **Confirmation:** only staff confirm, after checking payment. "Confirm without advance" only for verified or returning customers.
- **Limits:** customers can have only the set number of unpaid requests; online cancellation closes the set hours before pickup. A driver can't be on two overlapping trips. A trip can't start before its date or without a driver.
- **Agent:** never states a price, availability or policy that didn't come from the business data; it prepares a booking card but only the customer's tap sends it.

## Security

Passwords hashed with scrypt; sessions are random tokens in HttpOnly SameSite cookies (only hashes stored); account lockout after 5 wrong passwords; per-IP rate limits; a required request header blocks cross-site form posts; strict Content-Security-Policy (no inline scripts); uploaded files checked by content, not name; the agent proxy only accepts the site's own tools, adds a travel-only system prompt and caps response length.

## Project layout

```
src/site.html          The page (also what's published in Claude)
scripts/build.js       Builds public/ from src/site.html (runs on start)
public/claude-shim.js  Adapter: accounts, data, photos and agent for the page, backed by this server
server/server.js       Express server: auth, document store API, live updates, photos, Claude proxy
server/rules.js        Access rules
server/store.js        JSON-file storage with atomic writes
test/                  node:test suites
```

## Deploying

See **DEPLOY.md** for going live on your own domain (Docker + automatic HTTPS + daily backups).


Any Node host (Render, Railway, a VPS with PM2 + Nginx). Serve over HTTPS and set `COOKIE_SECURE=1` (also required for the microphone). Set `TRUST_PROXY=1` behind a proxy. Keep `DATA_DIR` on persistent disk and back it up.

## Booking flow

The booking form is five separate checkout pages, each with its own address, so the browser's Back/Forward buttons, refresh and bookmarks work:

| Page | Address |
|---|---|
| Trip | `/#book-trip` (also `/book`) |
| Vehicle | `/#book-vehicle` |
| Your details (sign-in if needed) | `/#book-details` |
| Review | `/#book-review` (also `/checkout`) |
| Pay | `/#book-pay` (also `/pay`) |
| Confirmation | `/#booking-confirmed`, then redirects to My Trips after 10 seconds (or "Stay on this page") |

Every booking option opens the matching checkout page:

| Option | Opens |
|---|---|
| Book this vehicle (front or back of a fleet card) | Vehicle page with it selected if the trip is entered and it fits; Trip page if the trip is missing or it has too few seats; Vehicle page with a "booked on your dates" note and a free alternative if it's taken |
| Carousel front card / "Book this route" | Trip page with From, To and km filled in from the route table |
| How-it-works steps | Agent, Trip page, Pay page (or the first unfinished step), My Trips |
| Agent "Confirm & send" / My Trips "Open payment page" | Pay page for that booking |
| Successful payment or owner confirmation | Confirmation page, then My Trips |

The footer shows the site version (also at `/api/health`) so you can check you're running the latest files.

During checkout the rest of the site is hidden; "← Back to site" returns to it. A page opened before its earlier steps are complete redirects to the first unfinished step.

- "Book this vehicle" on a fleet card pre-selects it and opens the right step (trip details first if they're missing).
- Step 2 shows the selected vehicle's fare, advance and availability with a "Continue with …" button.
- Guests reaching step 3 are asked to sign in or create an account; the form is saved and they return to the same step afterwards.
- "Send request & pay advance" saves the request and moves to step 5: pay online (Razorpay, confirms instantly), or pay by UPI/bank and send the reference, or pay later from My Trips.
- Step 5 updates live: payment sent → verifying → booking confirmed (with driver details once assigned).

## Online payments (Razorpay)

Customers pay the advance by UPI, card, net banking or wallet in Razorpay's secure window; card and UPI details never touch this server.

1. Create an account at razorpay.com and get **test** API keys (Account & Settings → API Keys).
2. Put `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in `.env` and restart. A "Pay ₹… securely" button appears on unpaid trips under My Trips.
3. For live use, add a webhook in the Razorpay dashboard: URL `https://YOUR-DOMAIN/api/pay/webhook`, events `payment.captured`, `order.paid`, `payment.failed`, and a long secret in `RAZORPAY_WEBHOOK_SECRET`. It confirms payments even if the customer's browser closes mid-payment. (Webhooks can't reach `localhost`; test locally without one.)
4. When Razorpay activates your account, swap in the live keys.

How it stays safe:
- The server prices the advance from the saved rate card and route table; it ignores any amount the browser sends.
- Each payment is checked twice: the HMAC signature (order id | payment id, key secret) and a fetch of the payment from Razorpay's API (order, amount, currency, captured). Authorized-only payments are captured.
- Paid bookings confirm automatically and block the vehicle. If the vehicle was taken during payment, the money is kept, the booking is flagged "owner needs info" and the owner rebooks or refunds.
- Finalizing is idempotent: the checkout callback and the webhook can both arrive without double-confirming. Webhook signatures and event ids are checked.
- The owner refunds (full or partial, never more than paid) from the booking card in the Owner console.
- Manual UPI/bank transfer with a reference number remains available.

## Flights & hotels (Phase 1, v2.5)

The full lifecycle: **search live providers → compare → customer approves → pays (Razorpay) → provider confirms → My Trips and owner console.**

| Step | What happens |
|---|---|
| Search | Flights from Duffel, hotel rooms from liteAPI. Prices are converted to rupees with **your** exchange rates plus **your** service fee (Owner console → Flights & hotels). Offers in currencies you haven't priced are hidden — never guessed. |
| Compare | Sort by price, duration or departure; filter by airline or non-stop; hotel rooms with board and refund terms. |
| Details | Passenger names as on ID, date of birth (checked against adult/child/infant), email, phone with country code. Guests must sign in first; their selection is kept. |
| Approve & pay | The server re-checks the live price with the airline/hotel. If it moved, the customer must accept the new price. They tick an approval box, then pay the exact server-calculated total via Razorpay. The price hold lasts 30 minutes. |
| Confirm | After payment is verified, the server books with the provider and stores the PNR / hotel confirmation code and an invoice. **If the provider refuses, the customer is refunded in full automatically.** |
| Manage | My Trips shows status, invoice, and cancellation with a refund quote from the provider before confirming (the service fee is kept). |

The AI agent can also search (`search_flights`, `search_hotels`) and show results on the page, but booking and payment are always done by the customer on the checkout pages.

**Setup:** put `DUFFEL_ACCESS_TOKEN` and/or `LITEAPI_KEY` in `.env` (test/sandbox keys first), restart, then sign in as owner → Owner console → **Flights & hotels** → enter exchange rates (e.g. USD 84, GBP 110, EUR 92) and service fees → Save. Hotels are quoted in INR, so they work without rates. Razorpay keys are required for payment.

**Going live:** live Duffel token (needs a funded Duffel balance), live liteAPI key with a payment method on file, live Razorpay keys, `COOKIE_SECURE=1` on HTTPS.

## Phase 2 (v2.6): agent status answers, planner, budget, preferences, alerts

**One booking lifecycle for cabs, flights and hotels:** Pending payment → Payment received / being verified → Waiting for airline/hotel confirmation → Confirmed → Completed, plus Failed, Cancelled and Price hold expired. A booking is **never shown as confirmed just because payment succeeded**; the airline or hotel must confirm it.

**AI agent (Saarathi) new abilities**
| Tool | What it does |
|---|---|
| `get_booking_status` | Answers "is my hotel confirmed?", "where is my refund?", "status of HT-…" from live data: stage, PNR/hotel code, amounts, refund and date, cancellation option, next step, timeline. Staff can ask about any booking. |
| `find_alternatives` | For a failed or expired flight/hotel: fresh live search with the same details, price difference shown. Nothing is substituted without a new approval. |
| `save_trip_plan` | Extracts destination, dates, travellers, budget, trip type from a sentence ("Dubai 5 days, family, ₹80,000"), stores only what was said and asks for what's missing. |
| `get_trip_budget` | Total = flights + hotel + road transport + food + activities + other; remaining or overspend; cheaper options. |
| `save_itinerary_draft` | Day-by-day plan the customer can edit. |
| `get_preferences` / `save_preferences` / `delete_preferences` | Remembered only when the customer asks. |

**Trip planner & budget section:** the budget uses real numbers only (booked/held bookings, your selected live offer, the cheapest live result, our cab rate card, the customer's own estimates). Unpriced items are listed, never guessed. Over budget → red alert with cheaper options.

**Recommended fares:** flight results default to "Recommended", a balance of price, journey time, stops, refund terms, baggage and the customer's preferred airline. It isn't always the cheapest.

**Notifications:** bell icon with payment, confirmation, refund and status updates plus 48-hour trip reminders.

**Reconciliation (owner):** Owner console → Flights & hotels lists bookings needing attention (refund pending, or paid but unconfirmed for 15+ minutes). Use **Retry refund**; it can't refund twice.

## Notifications: Gmail, WhatsApp, SMS (v2.7)

Messages go to each customer's **registered email and mobile number** (the number they gave on the booking, else their account number). Each message is sent **once**; a failed channel is retried at most 3 times and the error is shown in Owner console → Notifications. On first start the current bookings are recorded as a baseline, so you don't get a burst of old messages.

| When | Customer gets | Owner gets |
|---|---|---|
| New booking request | – | ✓ |
| Payment received online | Cab: confirmation · Flight/hotel: "received, confirming" | ✓ |
| Confirmed / not available / needs info / cancelled / completed | ✓ | – |
| Owner adds or changes a note (last-minute update) | ✓ | – |
| Driver assigned or changed | ✓ driver name, phone, vehicle number | – |
| 24 h and 2 h before pickup | ✓ | – |
| ~30 min before estimated arrival at destination | ✓ (road km ÷ 45 km/h — an estimate, no GPS) | – |
| Last day of the trip, 8 am | ✓ trip-ending alert | – |
| Flight: confirmed, 24 h and 3 h before, 30 min before landing | ✓ (airport time zones) | – |
| Hotel: confirmed, evening before check-in, check-out morning | ✓ | – |
| Provider failed and refund pending | ✓ | ✓ Retry refund |
| Customer message to the owner | – | ✓ |

Customers can switch email, WhatsApp or SMS off in **My account → Booking notifications**. Without any keys nothing is sent and nothing is queued for later.

When the AI key is missing, the chat still answers booking status, contact and payment questions from the live data.

## Location, maps and weather (v2.8)

No keys needed: the server calls free public services (cached, rate-limited, 10-second timeouts) and the browser only talks to your server.

| Feature | What the customer sees | Business rule |
|---|---|---|
| Auto-detect location | Hero bar and a **📍 My location** button beside every starting-city field (booking pickup, planner, flight "From"). A tap always sets the starting city | Exact city from the device; if location is blocked or turned off, an approximate city from the internet connection (ipwho.is), marked "approx." |
| Road distance from the map | Booking step 1: **Road distance from map** fills the km and draws the route | A route not in your table is charged on the map distance: if the customer typed km more than 10% below the map distance, the server uses the map distance for the advance |
| Route map in the planner | Map with distance and driving time | Distance source is shown (OpenStreetMap / OSRM) |
| Weather for the trip dates | Day-by-day forecast, rain chance, warnings; rainy days marked in the day plan | Only up to 16 days ahead; later trips show when the forecast will be available, never a guess |
| Live trip tracking | My Trips → **Track trip** on the travel day: km to go, estimated time, live map, alarm at 2/5/10/20 km (sound, vibration, phone notification) | Works while the page is open; position used only to measure distance, not saved |
| AI agent | `get_weather`, `get_route_distance`, `get_my_location` | Weather-aware itineraries; map km before any approximation |

Services: [OpenStreetMap](https://www.openstreetmap.org/copyright) tiles and Nominatim, [OSRM](https://project-osrm.org/) routing, [Open-Meteo](https://open-meteo.com/) weather. They are free for light use; for a busy site set `GEO_ROUTER_URL` to your own OSRM server and consider a commercial tile provider. Turn everything off with `MAPS=off`.

## Music and social media (v2.9)

- **Music button** (bottom-left): plays original background music generated in the browser (a tanpura-style drone with a soft Mohanam-scale melody), so there is no copyright issue. Off by default; browsers only allow sound after a tap. Volume slider; the choice is remembered. To use your own track, put an https link to an .mp3/.m4a/.ogg/.wav file (or copy the file into `public/music/` and enter `/music/yourfile.mp3`) in Business setup → **Background music file**. Use only music you own or have a licence for.
- **Social media**: Business setup → **Social media & music** takes Instagram, Facebook, YouTube, X, LinkedIn, Google reviews and a map/directions link (https only). Filled links show as icons in the footer and as buttons in Contact; WhatsApp uses the business number and also appears as a floating chat button with a ready "I'd like to book a trip" message. While the site still shows sample data, the icons point to the platforms' home pages so the client can review the layout.

## v3.0: 3D effects, footer navigation, form validation, quick contact

- **3D:** cards tilt towards the pointer with a soft light glare (desktop; off for "reduce motion"), sections swing gently into view, and the footer has a rotating 3D travel cube.
- **Footer navigation:** Explore, Book & plan, Help and Reach us columns, social icons and a Back-to-top button; it collapses to two columns on phones.
- **Form validation:** every form (booking steps, sign-in/sign-up, contact, planner, flights, hotels, passengers, profile, password, business setup, fleet) shows a clear message under the field: required fields, names, Indian mobile numbers, emails, dates (no past travel dates, check-out after check-in), number ranges, https links. Messages clear as soon as the field is fixed; the first problem is focused.
- **Quick contact:** "Ask us instantly" buttons and a floating contact button open WhatsApp (message pre-filled), Gmail (compose window with subject and message), Instagram direct message and a phone call. The contact form can also send the query by WhatsApp, Gmail or Instagram; a copy goes to the owner console when the customer is signed in.
- **Official brand icons:** the site draws its own simple icons. To show the platforms' official icons, save them in `public/brand/` (see the README there).

## Account security (v3.1)

| Protection | How it works |
|---|---|
| Strong passwords | New and changed passwords need 10+ characters with 3 of: lower-case, upper-case, numbers, symbols (or 16+ characters). Common passwords, sequences (12345), repeated characters, and the person's own name, email or mobile number are refused. A live strength meter and checklist show under the field. Existing passwords keep working. |
| Leaked-password check | Passwords seen in public data breaches are refused (Have I Been Pwned, k-anonymity: only the first 5 characters of a SHA-1 hash leave the server). `PWNED_CHECK=off` to disable. |
| Safe storage | Passwords: scrypt with a random salt. Sessions: only a hash of the cookie is stored; cookies are HttpOnly. Authenticator secrets: AES-256-GCM encrypted (`SECRET_KEY` or `data/.secret-key`). Backup codes: stored as hashes. |
| Two-step verification | My account → Security → set up with Google Authenticator / Microsoft Authenticator / Authy (QR code or key). Sign-in then needs the 6-digit code; codes can't be reused. 10 one-time backup codes (download or copy). Recommended for the owner (shown in Overview). |
| Account lock | 5 wrong passwords or codes lock the account for 15 minutes, plus per-address rate limits. Error messages never reveal whether an email is registered. |
| Show / hide password | Eye button on every password field. |
| Sign-in history & devices | Last 10 sign-ins (successful and failed) with device and partial address; list of signed-in devices; **Sign out all other devices**. Changing the password or turning on two-step signs out other devices. |
| Temporary passwords | Owner console → Team → **Reset password** (or **Reset password + 2-step** for a lost phone) gives a 12-character temporary password. The person must set their own before they can do anything else. |

## Explore Tamil Nadu: real destination photos (v3.2)

The **Explore Tamil Nadu** section (`/#explore`, or a direct link such as `/#explore-madurai`) shows 12 destinations: Kodaikanal, Ooty, Coimbatore, Valparai, Madurai, Rameswaram, Kanyakumari, Thanjavur, Chennai, Yercaud, Courtallam and Hogenakkal. Each has a cover photo, its named highlights (for example Coaker's Walk, Pamban Bridge, Five Falls), a gallery of 4–8 photos with filters, and a full-screen viewer (arrow keys, swipe, Escape).

**Where the photos come from.** The server collects them from **Wikimedia Commons**, the free media library behind Wikipedia, about 8 seconds after it starts and again every week. It checks each photo before using it:
- **Location:** it comes from that attraction's own Commons category (for example *Category:Pamban Bridge*). Search results are used only when the title or categories name the place.
- **Licence:** only licences that allow commercial use are accepted: CC0, public domain, CC BY and CC BY-SA. Non-commercial and no-derivatives licences are rejected.
- **Quality:** it must be a real photograph (JPEG, PNG or WebP), landscape, and at least 1600 px wide. Maps, plans, logos, drawings and old archive scans are excluded.
- **No repeats:** no photo is used for two destinations.
- **Working link:** every link is checked before it is shown. If a visitor's browser later fails to load one, the server re-checks it and hides it.

Every photo shows its photographer and licence, linking to the Commons page. The licences require this credit.

The first run takes a few minutes. Until it finishes, the section says photos are being collected.

**Owner console → Photos** lets you:
- see every destination's photos;
- choose the cover photo;
- hide a photo you don't like;
- refresh one destination or all of them;
- add licensed photos of your own (for example from Tamil Nadu Tourism or your own photographer). Give the link, photographer, licence and source.

Your choices and your photos survive the automatic refresh. Set `PHOTOS=off` to stop the automatic collection.

The destination list and highlights are in `server/destinations.json`. The selection rules are in `server/photopick.js`; `npm run build` copies both into the page.

## v3.3: contact changes with owner approval, one-tap call and message

- **Changing the name or phone after booking.** In My Trips, a customer taps **Change name or phone** on a booking and gives the authorised traveller's name, mobile number and an optional reason. The current details stay on the booking until the owner acts.
  - **Owner:** the request appears in Owner console → Bookings, counted in the badge, showing old → new details. Approve it, or reject it with a reason.
  - **Customer:** sees the result.
  - **Notifications:** the owner is told about the request. After approval, trip messages (WhatsApp/SMS) go to the new number.
  - **Enforced by the server:** customers can't edit a booking's name or phone directly.
- **One-tap contact.** Call, WhatsApp and SMS buttons with a pre-filled message naming the booking appear in three places:
  - on each booking in My Trips (to the business, and to the driver once assigned);
  - on each booking in the owner console (to the customer);
  - on the change request (to check the new number).
- **Contact icons only:** the footer and contact section show just WhatsApp, Instagram, Gmail, Call and SMS (v3.3.1). Official logos can be placed in `public/brand/` (e.g. `whatsapp.svg`, `gmail.svg`, `sms.svg`).

## v3.4: ratings and reviews

- **Who can review:** only customers whose trip is **completed**, checked by the server. They rate 1–5 stars and can add a short review (up to 500 characters) from My Trips. They can edit it later.
- **Owner:** gets a WhatsApp/email for each new review. Owner console → **Reviews** lets you publish a review (with an optional public reply) or hide it.
- **On the website:** published reviews appear in **What our travellers say** (`/#reviews`), with the average rating and a star breakdown. Only the first name and last initial are shown, never phone numbers. Customers can't add or publish reviews themselves.
- **No sample reviews:** the section stays empty until real reviews are published. Please publish honest reviews, good and bad, and hide only abusive or off-topic ones.

## Not built yet (needs the owner's accounts or decisions)

1. Opening-hours data for attractions (needs Google Places or similar).
1. Live GPS tracking (arrival alerts are estimates from road distance).
1. Price-trend prediction (needs historical fare data from a provider).
2. WhatsApp / SMS alerts and OTP verification (today the owner verifies phones by calling).
3. Password reset by email (today the owner issues a temporary password).
4. PostgreSQL instead of the JSON file once volume grows.
5. Connecting the Expo app to this server's API.
