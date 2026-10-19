"""Driver webhook declarations and generic direct/hub delivery contracts.

Signed provider requests enter the driver's fixed route on the node. Direct setup
uses a separate narrow listener; hub deployments relay to the authenticated node.
Both paths use the driver's URL variable and the shared ingestion pipeline.
"""
from __future__ import annotations

from enum import Enum
from typing import Any, ClassVar

from pydantic import ConfigDict, Field

from flow_sdk.schema.data_spec.spec import DataSpec

#: The machine route a pushing driver answers on (``server/routes/data_source_webhook.py``).
WEBHOOK_ROUTE = "/api/v1/data_source/webhook/{name}"


class DriverWebhookSpec(DataSpec):
    """``data_driver.json`` ``webhook`` — this driver takes pushes, and where its public URL goes."""

    model_config = ConfigDict(frozen=True)

    #: The ``auth.vars`` key whose variable holds this machine's public webhook URL (WhatsApp: ``webhook_url``).
    url_var: str
    #: The methods a provider uses (a GET challenge, POST deliveries).
    methods: list[str] = Field(default_factory=lambda: ["POST"])
    #: Headers every genuine delivery carries (the provider's signature) — a request without them is refused
    #: before it reaches the machine.
    required_headers: list[str] = Field(default_factory=list)


class DeploymentWebhookSpec(DataSpec):
    """One webhook a cloud deployment asks the hub for: named by its driver, its URL stored as ``var``."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "deployment.webhook"

    name: str
    #: The env var the webhook's public URL is stored and placed as (``FLOW_WHATSAPP_WEBHOOK_URL``).
    var: str
    #: The path on the machine (the driver's route).
    path: str
    methods: list[str] = Field(default_factory=lambda: ["POST"])
    required_headers: list[str] = Field(default_factory=list)


__all__ = ["WEBHOOK_ROUTE", "DeploymentWebhookSpec", "DriverWebhookSpec", "WebhookDelivery", "WebhookTargetSpec"]


class WebhookDelivery(str, Enum):
    HUB = "hub"
    DIRECT = "direct"


class WebhookTargetSpec(DataSpec):
    """An account/part and its payload, routed only after authentication of the original batch."""

    account: str
    part: str = ""
    payload: dict[str, Any]
