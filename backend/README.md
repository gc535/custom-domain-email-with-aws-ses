# Backend (AWS)

This backend implements basic custom-domain email with AWS SES:

- **Receives** mail at your domain via **SES**, stores raw messages in **S3**, and **forwards** them to your inbox using **Lambda**.
- **Sending:** either configure your email app with the SES SMTP endpoint and credentials, or use the send app in `../app/` to send without configuring a client.

## Architecture

```
  Inbound:
  Internet → MX (your domain) → SES (receive) → S3 (raw MIME) → Lambda → forward to your inbox

  Outbound:
  Your client app (SES SMTP configured) OR send app (../app) → SES → recipient sees From: you@yourdomain.com
```

**Stack:** S3 bucket (inbound mail + bounce/complaint storage), Lambda (forward-to-inbox, store-bounce-complaint), SES receipt rule set. Config from project root `.env`.

## Prerequisites

- **AWS CLI** and **SAM CLI** installed and configured.
- **Domain** you control.
- **Inbox address** where forwarded mail should go (e.g. you@outlook.com).

## Config

Copy the project root `.env.example` to `.env` and set at least:

- **DOMAIN_NAME** – Your email domain (e.g. yourdomain.com).
- **INBOX_EMAIL** – Address to receive forwarded mail.
- **HOSTED_ZONE_ID** – (Optional) Route 53 hosted zone ID. If set, the stack creates the SES domain identity and DKIM CNAME records so the domain verifies automatically.

## Deploy

1. Set `.env` at project root (or export `DOMAIN_NAME`, `INBOX_EMAIL`, and optionally `HOSTED_ZONE_ID`).
2. From this directory:

   ```bash
   chmod +x deploy.sh
   ./deploy.sh
   ```

3. **If you did not set HOSTED_ZONE_ID:** Add the **MX** record in your DNS so mail is delivered to SES:
   - **Name:** your domain (or `@`).
   - **Type:** MX  
   - **Value:** `10 inbound-smtp.<region>.amazonaws.com` (e.g. `10 inbound-smtp.us-east-1.amazonaws.com`).

   Then in **SES** → **Email receiving** → **Receipt rule sets**, set the stack’s rule set as **active**.

4. **If you set HOSTED_ZONE_ID:** The stack creates the MX record and activates the rule set; wait for DNS propagation.

## Backend storage

One S3 bucket (inbound + events), keyed by prefix:

- **`emails/`** – Raw inbound mail (MIME). Lambda reads from here and forwards to your inbox; lifecycle deletes after 7 days.
- **`bounce/`** and **`complaints/`** – SES bounce and complaint event payloads (stored by the store-bounce-complaint Lambda for book-keeping); lifecycle deletes after 90 days.