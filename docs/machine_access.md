---
id: 1bbf757d-8d50-4315-a0e4-bd087676bf0f
title: Unified machine access
tag: machine_access
tags:
- machine_access
- machine_access.model
- machine_access.model.build
- machine_access.identity
- machine_access.identity.build
- machine_access.privileged_access
- machine_access.privileged_access.build
- machine_access.lock
- machine_access.lock.build
- machine_access.remote_control
- machine_access.remote_control.build
description: How a machine connects to the hub as one compute node, how it is identified,
  and how its privileged access is allowed, locked and unlocked.
---
# Unified machine access

> Statements by the owner. A statement that contradicts today is a required change, and is true for
> the rest of the discussion.

```statements
tag: machine_access.model
statements:
  - text: 'A connected machine is a connected machine, whether it is from flow connect or from remote control. Single model: a compute node represents a machine.'
    basis: stated
    issues:
      - flow_sdk/server/routes/remote_control.py:214 registers this machine as a hub compute node (hub_node.ensure_node_strict) but starts no worker, so a machine set up from Remote control is a node that is never connected; only flow_sdk/cli/commands/connect_cmd.py:176 runs the worker that connects it.
      - flow_sdk/builtin/faas/compute_node.py:254 gives the app a second compute node for the same machine, @local, with an id of its own (local_entity_id), separate from the hub node that flow connect and Remote control create.
    about:
      - flow_sdk/core/compute/hub_node.py:158
      - flow_sdk/server/routes/remote_control.py:208
      - flow_sdk/cli/commands/connect_cmd.py:151
      - flow_sdk/builtin/faas/compute_node.py:254
```

```requirements
tag: machine_access.model.build
depends_on:
  - machine_access.model
requirements:
  - text: 'Setting up Remote control in flow_sdk/server/routes/remote_control.py must connect the machine the way flow connect does: the same worker (flow_sdk/compute/user_machine/worker.py) serving the same compute node, not a registration alone.'
  - text: The @local compute node (flow_sdk/builtin/faas/compute_node.py) and the machine's hub compute node must be one node for one machine, not two entries.
```

```statements
tag: machine_access.identity
depends_on:
  - machine_access.model
statements:
  - text: A machine is globally identifiable using get_machine_id of the sdk; the sdk may set a machine id override stored in global .flow/machine_id.
    basis: stated
    issues:
      - 'flow_sdk/utils/machine_id.py:29 get_machine_id never reads .flow/machine_id: it answers the value cached in <flow home>/global/system.json, else the id of the operating system.'
      - 'flow_sdk/core/compute/hub_node.py:46 machine_id() does not call get_machine_id: it mints a random uuid4 into ~/.flow/machine_id, and that value is the id flow connect (flow_sdk/cli/commands/connect_cmd.py:143) and Remote control (flow_sdk/server/routes/remote_control.py:214) give the hub for the compute node.'
      - flow_sdk/cloud_client/client_hooks.py:57 _local_machine_id builds a third id of its own for the X-Machine-ID header of every hub call, without get_machine_id.
    about:
      - flow_sdk/utils/machine_id.py:29
      - flow_sdk/core/compute/hub_node.py:46
      - flow_sdk/cloud_client/client_hooks.py:57
```

```requirements
tag: machine_access.identity.build
depends_on:
  - machine_access.identity
requirements:
  - text: get_machine_id in flow_sdk/utils/machine_id.py must answer the override stored in the global .flow/machine_id when there is one, before its cache and the id of the operating system.
  - text: flow_sdk/core/compute/hub_node.py must take the machine id of a compute node from get_machine_id and drop its own machine_id(); a machine already enrolled under the minted id in ~/.flow/machine_id must keep resolving to the same node.
  - text: flow_sdk/cloud_client/client_hooks.py must send get_machine_id as the X-Machine-ID header in place of its own _local_machine_id.
  - text: 'On a machine that has the override, the ids derived from the machine id (local_entity_id in flow_sdk/utils/machine_id.py: the @local user, project, workspace and compute node) change; the existing rows must be carried over to the new ids, not orphaned.'
```

```statements
tag: machine_access.privileged_access
depends_on:
  - machine_access.model
statements:
  - text: 'A connected node MAY allow privileged access: a special access allowing the hub to send shell / pty / IT messages / other privileged, machine-protected operations.'
    basis: stated
    issues:
      - flow_sdk/compute/user_machine/worker.py:135 serves every operation the hub sends (run, pty, reading, writing and deleting files, set_env) on every connected node; nothing on the node or the machine says whether privileged access is allowed, and no operation is marked privileged.
      - flow_sdk/server/routes/it_session.py:68 takes IT messages over the cookie gate of the machine, under its own IT Sessions preference (flow_sdk/core/compute/it_session.py:99), not under the access that covers shell and pty.
    about:
      - flow_sdk/compute/user_machine/worker.py:135
      - flow_sdk/server/routes/it_session.py:68
      - flow_sdk/core/compute/it_session.py:99
```

```requirements
tag: machine_access.privileged_access.build
depends_on:
  - machine_access.privileged_access
requirements:
  - text: A compute node must carry whether it allows privileged access, and flow_sdk/compute/user_machine/worker.py must refuse every privileged operation on a node that does not allow it.
  - text: The privileged operations must be named in one place (shell, pty, IT messages and the other machine-protected operations of flow_sdk/compute/user_machine/worker.py), so one check covers them all.
  - text: IT messages (flow_sdk/server/routes/it_session.py) must pass the same privileged-access check as shell and pty.
```

```statements
tag: machine_access.lock
depends_on:
  - machine_access.privileged_access
statements:
  - text: A machine may protect its privileged access with a device passkey. In such case the machine may be locked — it does not accept privileged access of any kind. Unlocked, an approved device receives signed messages over the channel, validates them and executes.
    basis: stated
    issues:
      - flow_sdk/core/compute/access_keys.py:233 is_on (the passkey window) is read only by flow_sdk/server/routes/remote_control.py; flow_sdk/compute/user_machine/worker.py:291 and flow_sdk/core/compute/it_session.py:99 never read it, so a machine whose passkey window is closed still runs every operation the hub sends.
      - flow_sdk/compute/user_machine/worker.py:291 executes each rest_api_msg frame as it arrives, with no signature on it and no validation; the passkey signs only the turn-on challenge, checked in flow_sdk/server/routes/remote_control.py:379.
    about:
      - flow_sdk/core/compute/access_keys.py:233
      - flow_sdk/server/routes/remote_control.py:359
      - flow_sdk/compute/user_machine/worker.py:291
```

```requirements
tag: machine_access.lock.build
depends_on:
  - machine_access.lock
requirements:
  - text: flow_sdk/compute/user_machine/worker.py and flow_sdk/server/routes/it_session.py must refuse every privileged operation while the machine is protected by a passkey and locked (flow_sdk/core/compute/access_keys.py is_on is false).
  - text: Each privileged message sent over the channel to an unlocked machine must carry a signature, and flow_sdk/compute/user_machine/worker.py must validate it before executing and refuse a message that fails.
```

```statements
tag: machine_access.remote_control
depends_on:
  - machine_access.model
  - machine_access.lock
statements:
  - text: flow connect creates a compute node; remote control is based on flow connect. The only difference is that the creation config defines the node "locked" within its creation, preventing privileged access without a passkey defined and signed on the device/machine.
    basis: stated
    issues:
      - flow_sdk/core/compute/hub_node.py:95 _node_config writes the same creation config for flow connect and for Remote control (machine_id, flavor, hostname, os, workspace_port); no key says "locked", and create_node (line 106) takes none.
      - 'flow_sdk/server/routes/remote_control.py:208 does not go through flow connect: it calls hub_node.ensure_node_strict (flow_sdk/core/compute/hub_node.py:158), a second path that only registers the node, while flow connect calls ensure_node (line 144) and then runs the worker.'
    about:
      - flow_sdk/core/compute/hub_node.py:95
      - flow_sdk/server/routes/remote_control.py:208
      - flow_sdk/cli/commands/connect_cmd.py:100
```

```requirements
tag: machine_access.remote_control.build
depends_on:
  - machine_access.remote_control
requirements:
  - text: create_node in flow_sdk/core/compute/hub_node.py must take a "locked" setting into the creation config of the node; Remote control (flow_sdk/server/routes/remote_control.py) creates its node with it, flow connect without it.
  - text: Remote control must create and serve its node through the flow connect path (one ensure function in flow_sdk/core/compute/hub_node.py and the same worker), differing from flow connect only in the "locked" creation config.
  - text: On a node created "locked", flow_sdk/compute/user_machine/worker.py must refuse privileged access until a passkey is defined on the machine and has signed there (an accepted key in flow_sdk/core/compute/access_keys.py and a verified answer).
```
