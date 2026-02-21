# Business Email for Your Domain

A simple, free custom-domain email setup using **Amazon AWS** so you can send and reply with addresses like `support@yourdomain.com`. Stack: **SES + S3 + Lambda + SNS**.

Inbound mail is forwarded to your own mailbox for real-time notification. 
Outbound can be done either by configuring SES SMTP in your email app, OR, use the **send app** in this project. (To save trouble and time :))

## What to do

| Folder / file | Purpose |
|---------------|--------|
| **`.env.example`** | Copy to `.env` (keep local and secret) and configure all project settings in one place. |
| **`backend/`** | AWS stack: receive mail, store in S3, forward to inbox. **Deploy from here.** See [backend/README.md](backend/README.md) for architecture and deployment. |
| **`app/`** | Local web UI to send email via SES when your client doesn’t support “Send as.” See [app/README.md](app/README.md) for setup. |

