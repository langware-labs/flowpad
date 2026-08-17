import { describe, expect, it } from 'vitest';

import { CapabilityManager, type CapabilitiesSummary } from '@sdk/capabilities/CapabilityManager';
import { Capability } from '@sdk/entities/capability';

describe('CapabilityManager resolved worker projection', () => {
  it('projects the selected harness worker from the backend summary', () => {
    const manager = new CapabilityManager();
    const harness = new Capability({
      id: '0f6339cf-3557-4f30-80a7-0a54d88ade9b',
      kind: 'harness',
      name: 'Default harness',
      reference_kind: 'harness.codex.cli',
    });
    (manager as unknown as { capabilities: Capability[] }).capabilities = [harness];
    manager.setSummary({
      intents: [],
      generated_at: '',
      capabilities: [
        {
          kind: 'harness.codex.cli',
          intent: 'harness',
          name: 'Codex CLI',
          description: '',
          icon: 'Terminal',
          available: true,
          checked: true,
          state: 'available',
          runnable: true,
          installable: true,
          worker_type: 'codex',
          homepage_url: null,
          reference_kind: null,
          dependencies: [],
          value: null,
          value_type: 'folder',
          last_process_id: null,
          message: '',
        },
      ],
    } satisfies CapabilitiesSummary);

    expect(manager.getSnapshot('harness').resolvedKind).toBe('harness.codex.cli');
    expect(manager.getSnapshot('harness').resolvedWorkerType).toBe('codex');
  });
});
