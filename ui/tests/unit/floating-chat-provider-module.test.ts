/**
 * The provider module exports the provider and nothing else.
 *
 * A module that exports a component next to a hook (or the context object) cannot be
 * hot-swapped in place: the dev server re-runs it alone and reloads its importers a
 * moment later. For that moment the mounted provider serves a NEW context while the
 * chat window and the assistant button still read the old one, and both throw
 * "useFloatingChat must be used inside <FloatingChatProvider>" under a provider that
 * is plainly mounted. The context and its hooks live in `floating-chat-context.ts`.
 */
import { describe, expect, it } from 'vitest';
import * as providerModule from '@src/components/floating-chat/FloatingChatContext';
import * as contextModule from '@src/components/floating-chat/floating-chat-context';

describe('floating chat provider module', () => {
  it('exports only the provider, so an edit below it swaps it in place', () => {
    expect(Object.keys(providerModule)).toEqual(['FloatingChatProvider']);
  });

  it('leaves the context and its hooks in the context module', () => {
    expect(Object.keys(contextModule).sort()).toEqual(['FloatingChatContext', 'useFloatingChat', 'useOptionalFloatingChat']);
  });
});
