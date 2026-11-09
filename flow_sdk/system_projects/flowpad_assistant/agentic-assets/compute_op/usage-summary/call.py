"""The Daily usage summary as a FlowCall block: the automation that runs it -> yesterday's ``usage.summary``.

Keeps the report (a ``UsageReport`` entity) and posts its headline into that automation's own
conversation on the Automations channel, the details as ``usage.summary.value.json``.
"""

import asyncio

from flow_sdk.app.automation_message import post_automation_result
from flow_sdk.builtin.usage_report import UsageReport
from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue
from flow_sdk.usage_report import analyze_usage, headline, render_markdown, yesterday


def _summarize():
    summary = analyze_usage(*yesterday())
    return summary, render_markdown(summary)


async def call(input, *, context) -> ReturnedValue:
    # Reading a day of transcripts takes seconds of CPU: off the server's event loop.
    summary, markdown = await asyncio.to_thread(_summarize)
    report = await UsageReport.from_data(summary, markdown=markdown).save()
    line = headline(summary)
    await post_automation_result(input, line, summary, asset_references=[str(report.typeid)])
    return ReturnedValue.satisfied(line, value=summary)
