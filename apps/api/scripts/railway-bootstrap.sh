#!/usr/bin/env bash
# Railway provisioning for feedsorter (Steps 2–6 of the managed-backend plan).
# Idempotent-ish: re-running will fail on `railway init` if the project is
# already linked. Safe to copy/paste lines individually.
#
# Prereqs:
#   brew install railway
#   railway --version  # >= 4.x
#
# Run from repo root.

set -euo pipefail

# --- Step 2: login + init -----------------------------------------------------
railway login
railway init --name feedsorter
railway link

# --- Step 3: postgres + pgvector ---------------------------------------------
railway add --database postgres
# Wait a moment for the Postgres service to be ready, then enable pgvector.
echo "Enabling pgvector extension on Postgres service..."
railway run --service Postgres psql -c "create extension if not exists vector;"

# --- Step 4: api + web services ----------------------------------------------
railway add --service api \
  --variables DATABASE_URL='${{Postgres.DATABASE_URL}}' \
  --variables NODE_ENV=production

railway add --service web \
  --variables NEXT_PUBLIC_API_URL='${{api.RAILWAY_PUBLIC_DOMAIN}}'

# --- Step 5: public domains ---------------------------------------------------
railway domain --service api
railway domain --service web

# --- Step 6: secrets ----------------------------------------------------------
# Set these manually; do NOT commit. The user must supply real values.
echo
echo "Now set the API secrets (placeholders shown):"
cat <<'EOF'
railway variables --service api \
  --set JWT_SECRET=$(openssl rand -hex 32) \
  --set STRIPE_SECRET_KEY=sk_live_REPLACE \
  --set STRIPE_WEBHOOK_SECRET=whsec_REPLACE \
  --set STRIPE_PRICE_PRO=price_REPLACE \
  --set STRIPE_PRICE_PRO_FOUNDING=price_REPLACE \
  --set RESEND_API_KEY=re_REPLACE \
  --set GROQ_API_KEY=gsk_REPLACE \
  --set OPENAI_API_KEY=sk-REPLACE
EOF
