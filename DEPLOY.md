# Deploying Sashwanth Travels (go live on your own domain)

**What you get:** the website on `https://yourdomain`, a free HTTPS certificate that renews itself, automatic restart if the server reboots, and a daily backup of all bookings, accounts and photos.

**What you need:**
- A **domain name**, e.g. `sashwanthtravels.in`, from any registrar.
- A small **Linux server (VPS)**: Ubuntu 24.04, 1 vCPU, 1–2 GB RAM, 25 GB disk. Pick a data centre in **India** (Mumbai, Bangalore or Chennai) so it's fast for your customers. Any provider that sells an Ubuntu VPS with a public IP works.

> Shared "website hosting" plans (the cPanel kind, made for PHP sites) won't work. This site needs Node.js and a disk that keeps its data.

---

## 1. Point the domain to the server

In your domain registrar's **DNS settings**, add:

| Type | Name | Value |
|---|---|---|
| A | `@` | your server's IP address |
| A | `www` | your server's IP address |

DNS can take from a few minutes to a few hours to update.

## 2. Copy the website to the server (from your Windows PC)

PowerShell already includes `ssh` and `scp`. Replace `SERVER_IP` with your server's address:

```powershell
cd $HOME\Downloads
scp .\sashwanth-travels-v3.4.1.zip root@SERVER_IP:/opt/
# optional: bring your existing bookings and accounts from the PC
scp -r C:\projects\sashwanth-travels\data root@SERVER_IP:/opt/data-from-pc
ssh root@SERVER_IP
```

Then, on the server:

```sh
apt-get update && apt-get install -y unzip
cd /opt && unzip -o sashwanth-travels-v3.4.1.zip
cd /opt/sashwanth-travels
[ -d /opt/data-from-pc ] && cp -r /opt/data-from-pc ./data
sh deploy/setup-server.sh
```

`setup-server.sh` installs Docker, opens only the web ports (80/443) plus SSH in the firewall, prepares the data folder and schedules the daily backup.

## 3. Create the production settings (`.env`)

```sh
cp .env.example .env
nano .env
```

Fill in at least the following (save with **Ctrl+O**, **Enter**, then **Ctrl+X**):

```
DOMAIN=sashwanthtravels.in
PUBLIC_URL=https://sashwanthtravels.in
OWNER_NAME=...   OWNER_EMAIL=...   OWNER_PHONE=...   OWNER_PASSWORD=...(a strong one)
SECRET_KEY=      ← paste the output of:  openssl rand -hex 32
RAZORPAY_KEY_ID=...  RAZORPAY_KEY_SECRET=...  RAZORPAY_WEBHOOK_SECRET=...
ANTHROPIC_API_KEY=...
SMTP_USER=...  SMTP_PASS=...      (and WhatsApp / SMS / liteAPI keys if you have them)
```

`COOKIE_SECURE=1` and `TRUST_PROXY=1` are set automatically by `docker-compose.yml`. Then protect the file: `chmod 600 .env`

> **SECRET_KEY:** if you copied `data` from your PC, leave it blank. The existing `data/.secret-key` is used, and everyone's two-step verification keeps working.

## 4. Start it

```sh
docker compose up -d --build
docker compose logs -f app      # press Ctrl+C to stop watching
```

Open `https://yourdomain`. The footer should show the version, and `https://yourdomain/api/health` should show `"ok":true`. The HTTPS certificate is issued automatically on the first visit once DNS points to the server.

## 5. After going live

1. **Owner console → My account → Security:** turn on two-step verification.
2. **Razorpay dashboard → Webhooks:** URL `https://yourdomain/api/pay/webhook`, events `payment.captured`, `order.paid`, `payment.failed`, with the same secret as `RAZORPAY_WEBHOOK_SECRET`.
3. **Live keys:** switch Razorpay (and the other providers) from test keys to live keys after their business verification (KYC), then run `docker compose up -d`.
4. **Owner console → Notifications → Send a test:** check email and WhatsApp.
5. **One real booking:** make a small booking end to end and refund it.

## Updating to a new version

From the PC:

```powershell
scp .\sashwanth-travels-vX.Y.zip root@SERVER_IP:/opt/
```

On the server:

```sh
cd /opt && unzip -o sashwanth-travels-vX.Y.zip
cd /opt/sashwanth-travels && docker compose up -d --build
```

`.env` and `data/` are not inside the zip, so they're never overwritten.

## Backups

- Every night at 02:30 a backup of `data/` and `.env` is saved in `/opt/sashwanth-travels/backups/`; 14 days are kept.
- **Also copy backups off the server** now and then, for example to your PC:
  `scp root@SERVER_IP:/opt/sashwanth-travels/backups/data_*.tar.gz .`
- **Restore:** stop with `docker compose down`, then `tar -xzf backups/data_DATE.tar.gz`, then `docker compose up -d`.

## Troubleshooting

| Problem | Fix |
|---|---|
| Browser says the site can't be reached | DNS not updated yet (check the A records), or ports 80/443 are blocked in the provider's own firewall panel |
| "Certificate" or "Not secure" warning | Wait a few minutes after DNS is correct, then check `docker compose logs caddy` |
| Site loads but data is missing | You started without copying `data/` from the PC; copy it in and run `docker compose restart app` |
| Changed `.env` but nothing changed | Run `docker compose up -d` (a restart alone doesn't reload `.env`) |
| See errors | `docker compose logs --tail 100 app` |

---

# Alternative: Render (no server to manage)

Render runs the site for you; you don't log in to a Linux server. You still need the **paid Starter plan with a disk**. On the free plan the site sleeps after 15 minutes of no visitors and has no disk, so every account and booking would be lost at each restart and deploy. Vercel doesn't work for this site: it runs code only briefly per request, has no disk, and can't keep reminders, alarms, live updates or photo collection running.

1. Put the project on **GitHub** (a private repository). `.gitignore` keeps `.env`, `data/` and `node_modules/` out.
2. Render → **New → Blueprint** → connect GitHub → pick the repository. `render.yaml` sets up the service, a 1 GB disk at `/var/data`, the build and start commands, and the health check.
3. Fill in the secret values it asks for: `PUBLIC_URL` (e.g. `https://sashwanth-travels.onrender.com`, or your own domain later), the owner details and your API keys. Add any other keys from `.env.example` under **Environment** (WhatsApp, SMS, liteAPI and others).
4. Deploy. Open the `.onrender.com` address; `/api/health` should show `"ok":true`.
5. **Own domain:** Settings → Custom Domains → add `sashwanthtravels.in`, create the DNS records Render shows, then update `PUBLIC_URL`.
6. **Razorpay webhook:** `https://YOUR-ADDRESS/api/pay/webhook`.
7. **Updates:** push to GitHub and Render redeploys automatically. The disk (accounts, bookings, photos, encryption key) is kept.
8. **Backups:** Render takes daily disk snapshots. Download your own copy now and then from the service's **Shell** tab: `tar -czf /tmp/backup.tgz -C /var/data .`
