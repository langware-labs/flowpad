"""Status facts as yes/no questions -- what `flow status --check` and a compute op's
``status_check`` both ask.

Facts:

* ``install:<harness>`` -- is that harness's CLI here (installed, or built in).
* ``source_step:<source id>:<step>`` -- does that data source's setup step hold now (``DataSource.step``). A
  setup gate re-asks it every few seconds while a person acts elsewhere (a phone sends a code), so it must not
  start the ``flow`` CLI each time: that takes a minute on a slow Windows machine.

``<harness>`` is any spelling of a vendor (``claude``, ``claude_code``, ``harness.claude.cli``)
or ``default``, the user's default harness.
"""

from __future__ import annotations


class UnknownStatusFact(ValueError):
    """A fact this layer does not answer, or a harness no vendor has."""


def harness_kind(name: str) -> str:
    """A harness name, in any spelling, as its capability kind; ``""`` when none matches."""
    from flow_sdk.flowpad_types.vendors import vendor_by, vendor_or_none  # noqa: PLC0415

    vendor = vendor_or_none(name) or vendor_by("capability_kind", name)
    return vendor.capability_kind if vendor is not None else ""


def install_target(fact: str) -> str:
    """The harness an ``install:<harness>`` fact names, still unresolved (``default`` stays)."""
    kind, _, name = fact.partition(":")
    if kind != "install" or not name:
        raise UnknownStatusFact(f"unknown status fact {fact!r}; use install:<harness>")
    return name


SOURCE_STEP = "source_step"


async def _source_step(fact: str) -> tuple[bool, str]:
    """``source_step:<source id>:<step>``: that source's setup step, run as its gate runs it (it may store what it
    learns -- the phone a link proved)."""
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    _, source_id, step = (fact.split(":", 2) + ["", ""])[:3]
    if not source_id or not step:
        raise UnknownStatusFact(f"unknown status fact {fact!r}; use {SOURCE_STEP}:<source id>:<step>")
    source = await DataSource.get_by_id(source_id)
    if source is None:
        return False, f"no data source {source_id}"
    answer = await source.step(step)
    return answer.ok, str(answer.detail or "")


async def check_fact(fact: str) -> tuple[bool, str]:
    """Answer *fact* fresh: re-discover the harness it names, then read its ``install``.

    In-process, for a caller that IS the backend (a compute op's ``status_check``): the same
    answer `flow status --refresh --check` gives, without a shell, a CLI start or an HTTP
    round trip back into this process.
    """
    from flow_sdk.core.status.build import default_harness_kind, harness_install  # noqa: PLC0415
    from flow_sdk.core.status.refresh import refresh_status  # noqa: PLC0415
    from flow_sdk.flowpad_types.vendors import vendor_by  # noqa: PLC0415
    from flow_sdk.schema.data_spec.status_spec import InstallState  # noqa: PLC0415

    if fact.startswith(SOURCE_STEP + ":"):
        return await _source_step(fact)
    name = install_target(fact)
    kind = await default_harness_kind() if name == "default" else harness_kind(name)
    vendor = vendor_by("capability_kind", kind) if kind else None
    if vendor is None:
        raise UnknownStatusFact(f"no harness named {name!r}")
    await refresh_status([kind])
    install = harness_install(vendor.key)
    held = install in (InstallState.INSTALLED, InstallState.BUILT_IN)
    return held, f"{vendor.key} is {install.value.replace('_', ' ')}"
