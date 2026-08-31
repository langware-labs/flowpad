#!/usr/bin/env bash
# One-time setup of the isolated flowpad-playground GCP project:
#   - enables the required APIs
#   - creates the budget-alerts Pub/Sub topic
#   - creates a $100/month budget (alerts at 50% / 90% / 100%) wired to the topic
#   - deploys the budget-guard Cloud Function (gen2) that, at 100% of budget,
#     stops all Compute instances and detaches billing from the project
#
# Security layering (why this exists):
#   1. The app pins CLOUDSDK_CORE_PROJECT=flowpad-playground into every worker
#      env (flow_sdk config gcp_deployment_project_id) — advisory: an agent that
#      explicitly passes --project langware still succeeds under the user's ADC.
#   2. Hard isolation (follow-up): a dedicated deployer SA with roles only in
#      flowpad-playground, injected as GOOGLE_APPLICATION_CREDENTIALS.
#   3. This script's budget kill-switch — bounds the blast radius even if 1-2
#      are bypassed. Note billing data lags, so $100 is a soft-realtime cap.
#
# Idempotent: safe to re-run; existing resources are left in place.
set -euo pipefail

PROJECT="${GCP_DEPLOYMENT_PROJECT_ID:-flowpad-playground}"
REGION="${GCP_REGION:-us-central1}"
TOPIC="budget-alerts"
BUDGET_NAME="flowpad-playground-100-cap"
# In the billing account's own currency (the budgets API rejects a mismatched
# currencyCode). Ours is ILS; 340 ILS ~= $100/month.
BUDGET_AMOUNT="${BUDGET_AMOUNT:-340}"
GUARD_SA_NAME="budget-guard"
GUARD_SA="${GUARD_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
FUNCTION_NAME="budget-guard"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUNCTION_SRC="${SCRIPT_DIR}/gcp_playground_budget_guard"

echo "== target project: ${PROJECT} =="
BILLING_ACCOUNT=$(gcloud billing projects describe "${PROJECT}" --format='value(billingAccountName)')
if [[ -z "${BILLING_ACCOUNT}" ]]; then
  echo "ERROR: ${PROJECT} has no billing account attached (or you lack access)." >&2
  exit 1
fi
BILLING_ACCOUNT_ID="${BILLING_ACCOUNT#billingAccounts/}"
echo "billing account: ${BILLING_ACCOUNT_ID}"

echo "== enabling APIs =="
gcloud services enable compute.googleapis.com pubsub.googleapis.com \
  cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  eventarc.googleapis.com cloudbilling.googleapis.com \
  billingbudgets.googleapis.com --project="${PROJECT}"

echo "== pub/sub topic =="
gcloud pubsub topics describe "${TOPIC}" --project="${PROJECT}" >/dev/null 2>&1 \
  || gcloud pubsub topics create "${TOPIC}" --project="${PROJECT}"
# The budgets API refuses (FAILED_PRECONDITION) a notifications rule unless the
# Cloud Billing budget service agent can publish to the topic. If the org's
# domain-restricted-sharing policy blocks the grant, override it on THIS
# project only:  gcloud org-policies reset iam.allowedPolicyMemberDomains \
#                  --project="${PROJECT}"   (needs orgpolicy admin)
if ! gcloud pubsub topics add-iam-policy-binding "${TOPIC}" --project="${PROJECT}" \
  --member="serviceAccount:billing-budget-alert@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher" --quiet >/dev/null; then
  echo "ERROR: could not grant pubsub.publisher to the budget service agent." >&2
  echo "Likely the iam.allowedPolicyMemberDomains org policy — see comment above." >&2
  exit 1
fi

echo "== budget (${BUDGET_AMOUNT} account-currency/month ~= \$100, thresholds 50/90/100%) =="
EXISTING_BUDGET=$(gcloud billing budgets list --billing-account="${BILLING_ACCOUNT_ID}" \
  --filter="displayName=${BUDGET_NAME}" --format='value(name)' | head -1)
if [[ -n "${EXISTING_BUDGET}" ]]; then
  echo "budget already exists: ${EXISTING_BUDGET}"
else
  gcloud billing budgets create \
    --billing-account="${BILLING_ACCOUNT_ID}" \
    --display-name="${BUDGET_NAME}" \
    --budget-amount="${BUDGET_AMOUNT}" \
    --filter-projects="projects/$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')" \
    --threshold-rule=percent=0.5 \
    --threshold-rule=percent=0.9 \
    --threshold-rule=percent=1.0 \
    --notifications-rule-pubsub-topic="projects/${PROJECT}/topics/${TOPIC}"
fi

echo "== guard service account =="
gcloud iam service-accounts describe "${GUARD_SA}" --project="${PROJECT}" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "${GUARD_SA_NAME}" \
       --project="${PROJECT}" --display-name="Budget guard (stop VMs + detach billing)"
# Grants are project-scoped ONLY — nothing on langware or the billing account.
# Retry: a freshly created SA takes a little while to become visible to IAM.
# run.invoker: the Eventarc trigger runs as this SA and must invoke the function.
for role in roles/compute.instanceAdmin.v1 roles/billing.projectManager roles/run.invoker; do
  n=0
  until gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${GUARD_SA}" --role="${role}" --quiet >/dev/null 2>&1; do
    n=$((n + 1))
    if [[ ${n} -gt 12 ]]; then
      echo "ERROR: could not grant ${role} to ${GUARD_SA} after ${n} attempts." >&2
      exit 1
    fi
    sleep 10
  done
  echo "granted ${role}"
done

echo "== deploying budget-guard function =="
# Gen2 function builds run as the default compute SA, which in a fresh project
# under org policies has no roles at all — grant it the builder role.
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.builder" --quiet >/dev/null
gcloud functions deploy "${FUNCTION_NAME}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --gen2 \
  --runtime=python312 \
  --source="${FUNCTION_SRC}" \
  --entry-point=budget_guard \
  --trigger-topic="${TOPIC}" \
  --service-account="${GUARD_SA}" \
  --trigger-service-account="${GUARD_SA}" \
  --memory=512Mi \
  --set-env-vars="GUARD_PROJECT=${PROJECT}" \
  --no-allow-unauthenticated

echo "== done =="
echo "Verify: gcloud billing budgets list --billing-account=${BILLING_ACCOUNT_ID}"
echo "Drill:  gcloud pubsub topics publish ${TOPIC} --project=${PROJECT} \\"
echo "          --message='{\"costAmount\":101,\"budgetAmount\":100,\"alertThresholdExceeded\":1.0}'"
echo "        (re-attach billing afterwards: gcloud billing projects link ${PROJECT} --billing-account=${BILLING_ACCOUNT_ID})"
