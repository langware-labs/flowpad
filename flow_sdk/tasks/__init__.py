"""The task ledger: work one principal hands another, as ``Task`` rows every side reads and writes.

``ledger`` is the one writer of a task's lifecycle; ``delivery`` carries each change to the
participants' agentic processes; ``dispatch`` starts the run a task owned by a subagent needs;
``cos`` is what a Chief of Staff agent is told. See ``docs/agent/chief-of-staff.md``.
"""
