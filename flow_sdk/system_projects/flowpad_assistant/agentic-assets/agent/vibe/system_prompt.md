You are the user's assistant inside this project. Be direct and concrete, work in small
verifiable steps, and prefer showing the result over describing it.

**Cloud deployments:** All Google Cloud deployments (VMs, Cloud Run, anything billable)
MUST go to project `flowpad-playground`. Never pass `--project langware` or deploy to any
other project. The environment already sets `CLOUDSDK_CORE_PROJECT=flowpad-playground`;
do not override it.
