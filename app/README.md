# Send app

Simple web UI to send email via **SES SMTP** as your domain addresses.

## Setup

1. Copy the project root **`.env.example`** to **`.env`** and fill in the required values:
   - **DOMAIN_NAME** – Your sending domain (e.g. `yourdomain.com`); used to build From addresses.
   - **FROM_LOCAL_PARTS** – Comma-separated local parts for the From dropdown (e.g. `support,help` → `support@domain`, `help@domain`).
   - **SES_SMTP_USER** / **SES_SMTP_PASS** – SES SMTP credentials from AWS SES → SMTP settings (required to send).

2. Install and run:

   ```bash
   cd app
   npm install
   npm start
   ```

3. Open **http://localhost:3333/** in the browser. If you set `SEND_APP_SECRET` in `.env`, use **http://localhost:3333/?key=YOUR_SECRET**.

## Structure

- **`server.js`** – Express server: serves the form and `POST /send` to send via Nodemailer + SES SMTP; `GET /config` returns From addresses from config.
- **`public/index.html`** – Single-page form: From (loaded from `/config`), To, Subject, Message (rich text).
- **`.env`** – Project root config (see `.env.example`). App-specific overrides (e.g. `SEND_APP_SECRET`) can go in `app/.env` if you prefer.

## Security

- Run locally only, or protect with `SEND_APP_SECRET` (query param or body field `key`).
- Do not expose the app to the internet without auth.
- Keep your secret value secret; do not push `.env` to git.
