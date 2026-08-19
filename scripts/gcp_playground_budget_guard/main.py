"""Budget kill-switch for the flowpad-playground GCP project.

Gen2 Cloud Function triggered by the `budget-alerts` Pub/Sub topic (wired to
the $100 budget by scripts/setup_gcp_playground.sh). Below 100% of budget it
only logs. At >= 100% it caps the blast radius, in order:

1. Stops every running Compute Engine instance in the project.
2. Detaches the billing account from the project (the canonical GCP
   "cap spending" recipe) — all billable services shut down until a human
   re-attaches billing.

Runs under a dedicated service account whose only grants are
roles/compute.instanceAdmin.v1 and roles/billing.projectManager ON
flowpad-playground — it cannot touch the production project or the billing
account itself.

Billing export lags (minutes to hours), so the cap is soft-realtime; the
stop+detach combination bounds the overrun.
"""

from __future__ import annotations

import base64
import json
import os

import functions_framework
from google.cloud import billing_v1, compute_v1

PROJECT = os.environ.get("GUARD_PROJECT", "flowpad-playground")


def _stop_all_instances() -> int:
    client = compute_v1.InstancesClient()
    stopped = 0
    request = compute_v1.AggregatedListInstancesRequest(project=PROJECT)
    for zone_path, scoped in client.aggregated_list(request=request):
        for instance in scoped.instances or []:
            if instance.status not in ("RUNNING", "PROVISIONING", "STAGING"):
                continue
            zone = zone_path.rsplit("/", 1)[-1]
            print(f"stopping {instance.name} in {zone}")  # noqa: T201 — Cloud Function logs
            client.stop(project=PROJECT, zone=zone, instance=instance.name)
            stopped += 1
    return stopped


def _detach_billing() -> None:
    client = billing_v1.CloudBillingClient()
    client.update_project_billing_info(
        name=f"projects/{PROJECT}",
        project_billing_info=billing_v1.ProjectBillingInfo(billing_account_name=""),
    )
    print(f"billing detached from {PROJECT}")  # noqa: T201 — Cloud Function logs


@functions_framework.cloud_event
def budget_guard(cloud_event) -> None:
    payload = json.loads(base64.b64decode(cloud_event.data["message"]["data"]))
    cost = float(payload.get("costAmount") or 0)
    budget = float(payload.get("budgetAmount") or 0)
    threshold = float(payload.get("alertThresholdExceeded") or 0)
    print(f"budget notification: cost={cost} budget={budget} threshold={threshold}")  # noqa: T201 — Cloud Function logs

    over_budget = threshold >= 1.0 or (budget > 0 and cost >= budget)
    if not over_budget:
        return

    stopped = _stop_all_instances()
    print(f"stopped {stopped} instance(s)")  # noqa: T201 — Cloud Function logs
    _detach_billing()
