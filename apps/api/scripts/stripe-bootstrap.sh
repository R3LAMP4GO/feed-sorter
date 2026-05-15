#!/usr/bin/env bash
# Stripe products + prices bootstrap.
# Mirrors `stripe-samples/checkout-single-subscription` README idiom:
#   stripe products create --name=… ; stripe prices create -d product=… -d unit_amount=…
#
# Run AFTER `stripe login`. Idempotent re-runs will create duplicate products —
# delete or archive prior ones if you re-run.
#
# Required: jq

set -euo pipefail

if ! command -v stripe >/dev/null 2>&1; then
  echo "stripe CLI not found. brew install stripe/stripe-cli/stripe" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found. brew install jq" >&2
  exit 1
fi

echo "Creating Pro product…"
PRO_PRODUCT=$(stripe products create \
  --name="Feed Sorter Pro" \
  --description="Unlimited capture, transcription, hook extraction, dashboard." \
  -d "metadata[tier]=pro" \
  --format=json | jq -r '.id')

echo "Creating Pro price (\$19/mo)…"
PRO_PRICE=$(stripe prices create \
  -d product="$PRO_PRODUCT" \
  -d unit_amount=1900 \
  -d currency=usd \
  -d "recurring[interval]=month" \
  -d "metadata[tier]=pro" \
  --format=json | jq -r '.id')

echo "Creating Pro Founding product…"
PRO_FOUNDING_PRODUCT=$(stripe products create \
  --name="Feed Sorter Pro (Founding)" \
  --description="Founding-member rate" \
  -d "metadata[tier]=pro" \
  -d "metadata[variant]=founding" \
  --format=json | jq -r '.id')

echo "Creating Pro Founding price (\$19/mo)…"
PRO_FOUNDING_PRICE=$(stripe prices create \
  -d product="$PRO_FOUNDING_PRODUCT" \
  -d unit_amount=1900 \
  -d currency=usd \
  -d "recurring[interval]=month" \
  -d "metadata[tier]=pro" \
  -d "metadata[variant]=founding" \
  --format=json | jq -r '.id')

echo "Creating Studio product…"
STUDIO_PRODUCT=$(stripe products create \
  --name="Feed Sorter Studio" \
  --description="Pro plus higher monthly LLM caps, multi-seat workspaces, priority transcription." \
  -d "metadata[tier]=studio" \
  --format=json | jq -r '.id')

echo "Creating Studio price (\$49/mo)…"
STUDIO_PRICE=$(stripe prices create \
  -d product="$STUDIO_PRODUCT" \
  -d unit_amount=4900 \
  -d currency=usd \
  -d "recurring[interval]=month" \
  -d "metadata[tier]=studio" \
  --format=json | jq -r '.id')

cat <<EOF

Done. Set these on Railway:

  STRIPE_PRICE_PRO=$PRO_PRICE
  STRIPE_PRICE_PRO_FOUNDING=$PRO_FOUNDING_PRICE
  STRIPE_PRICE_STUDIO=$STUDIO_PRICE

EOF
