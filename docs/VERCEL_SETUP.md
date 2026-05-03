# Vercel Setup

This repo should be deployed as two separate Vercel projects from the same GitHub repository.

## Projects

### House Cleaning

- Framework preset: Next.js
- Root directory: `apps/house-cleaning`
- Install command: `npm install`
- Build command: `npm run build`
- Output directory: leave default
- Development command: `npm run dev`

### Window Washing / WinBros

- Framework preset: Next.js
- Root directory: `apps/window-washing`
- Install command: `npm install`
- Build command: `npm run build`
- Output directory: leave default
- Development command: `npm run dev`

## Required Environment Variables

These are the minimum variables needed for the app to boot and talk to Supabase:

```env
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ANON_KEY=
SUPABASE_JWT_SECRET=
CRON_SECRET=
NEXT_PUBLIC_APP_URL=
NEXT_PUBLIC_SITE_URL=
NEXT_PUBLIC_BASE_URL=
NEXT_PUBLIC_DOMAIN=
SERVICE_TYPE=
```

Use `SERVICE_TYPE=house-cleaning` for the house-cleaning project and `SERVICE_TYPE=window-washing` for the WinBros project.

## Feature Credentials

Add these only for the workflows you want active:

- Stripe payments: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- SMS: `OPENPHONE_API_KEY`, `OPENPHONE_WEBHOOK_SECRET`, `OPENPHONE_PHONE_ID`, `OPENPHONE_PHONE_NUMBER`
- Voice AI: `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_ID`
- AI replies/assistant: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
- Maps/address autocomplete: `GOOGLE_MAPS_API_KEY`
- Crew dispatch: `TELEGRAM_BOT_TOKEN`
- HouseCall Pro sync: `HOUSECALL_PRO_API_KEY`, `HOUSECALL_PRO_COMPANY_ID`, `HOUSECALL_PRO_WEBHOOK_SECRET`
- HubSpot sync: `HUBSPOT_ACCESS_TOKEN`
- Email: `GMAIL_USER`, `GMAIL_APP_PASSWORD`

## Local Commands

```bash
npm install
npm run dev --workspace=apps/house-cleaning
npm run dev --workspace=apps/window-washing
npm run build --workspace=apps/house-cleaning
npm run build --workspace=apps/window-washing
```

Local `.env.local` scaffold files have been created at the repo root and inside both app folders. Replace the placeholder Supabase values before expecting login/dashboard data to work.
