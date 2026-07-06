import {
  AgentConfig,
  AgenticProcess,
  ComputeNode,
  ComputeProviderType,
  ConnectionManager,
  ContextEntitiesEnum,
  FlowData,
  InstructionFile,
  User,
  apiClient,
  clearStats,
  dataManager,
  dataContext,
  instancePreferences,
  GRAPH_API_PREFIX,
} from '@sdk';
import { v4 as uuidv4 } from 'uuid';
import type { AgenticContext, PermissionMode } from '@sdk';
import { Blob } from 'fetch-blob';
import { afterEach } from 'vitest';

/**
 * Stubs for cloud auth helpers. Minihub uses zero-auth so these are no-ops,
 * but many test files import them so they must exist.
 */
export function getTestSignupInfo() {
  return { name: 'local', email: 'local@desktop.local', password: '' };
}
export function getTestLoginInfo(_signupInfo?: unknown) {
  return { email: 'local@desktop.local', password: '', remember_me: false };
}

let localUser: User | null = null;

/**
 * Unit test setup function that handles data manager reset for isolated unit tests
 * This ensures clean state between tests by clearing entity cache and subscriptions
 */
export async function unitTestSetup() {
  // Global polyfill for Blob
  globalThis.Blob = Blob;

  // Mock matchMedia for components that check pointer type (jsdom doesn't provide this)
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      }),
    });
  }

  // Reset data manager to clear entity cache and subscriptions
  await dataManager.reset();

  // Note: Shell sessions are now owned by ComputeNode (not ShellManager)
  // Sessions are automatically initialized when setActiveNode is called
  // For API tests, call shellManager.setActiveNode(computeNode) after setup

  const entities = dataManager.entities;
  noop(entities); //debug hook
}

/**
 * API test setup for minihub zero-auth environment.
 *
 * Minihub has no signup/login — the backend auto-authenticates every request
 * as the @local user with owner+su. This setup calls bootstrap to initialise
 * the SDK (schemas, context entities) and returns the @local user.
 */
export async function apiTestSetup(_signupInfo?: unknown, _test_name: string | null = null) {
  // Call unit test setup first to ensure clean state
  await unitTestSetup();

  // Bootstrap: creates @local entities and returns schemas + context
  const domain = window.location.hostname;
  const bootstrapInfo = await dataManager.bootstrap(domain, true);

  // Load the type registry (TypeInfo + schema) into the SchemaRegistry
  await dataManager.loadTypes(bootstrapInfo.types || []);

  // Store bootstrap info for UI access (desktop_info, etc.)
  dataContext.bootstrapInfo = bootstrapInfo;

  // Initialize compute node in context (mirrors main.ts initSdk)
  if (bootstrapInfo.default_compute_node) {
    const cn = new ComputeNode(bootstrapInfo.default_compute_node as any);
    cn.markAsExpanded();
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentComputeNodeTypeId, cn.typeId);
  }

  // Settle the registry-driven preferences load NOW (it needs the compute node
  // + bootstrap path, both just set). Otherwise its one-time async download of
  // preferences.json races into a later test's request window — e.g. the
  // request-counting tests that assert `save()` issues exactly one request would
  // otherwise see a stray background GET and read 2.
  await instancePreferences.loadJson();

  // Ensure websocket is connected for tests that rely on watch/stream notifications.
  const connectionManager = ConnectionManager.getInstance();
  if (!connectionManager.connected) {
    await connectionManager.connect();
  }

  // The @local user is returned by bootstrap — no login needed
  if (!localUser && bootstrapInfo.user) {
    localUser = dataManager.castAndDeepAssign(bootstrapInfo.user) as User;
  }

  clearStats();
  return localUser;
}

//no op function, just ot have linters and others shut up where no function is needed
export function noop(...args: any[]) {
  return args;
}

// Re-export stub utilities for convenience
export { getStubLabels, waitForLabels } from './stub_utils';

/** GET one graph row (unwrapped) by entity ``type`` + id. */
export async function fetchRow(type: string, id: string): Promise<any> {
  return apiClient.get<any>(`${GRAPH_API_PREFIX}/${type}/${id}`);
}

/**
 * Track created rows of ``type`` and drain-delete them in an ``afterEach``.
 * Call at module (or describe) scope; push new ids onto the returned ``created``
 * array and use ``fetchRow(id)`` to read one back.
 */
export function trackCreatedRows(type: string): {
  created: string[];
  fetchRow: (id: string) => Promise<any>;
} {
  const created: string[] = [];
  afterEach(async () => {
    while (created.length) {
      const id = created.pop()!;
      await apiClient.delete(`${GRAPH_API_PREFIX}/${type}/${id}`).catch(() => {});
    }
  });
  return { created, fetchRow: (id: string) => fetchRow(type, id) };
}

/**
 * Get a standardized agent configuration for execution tests
 * This ensures all tests use consistent agent settings for file creation and code execution
 */
export function getExecutionAgentConfig(
  name = 'execution-test-agent',
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return AgentConfig.forExecution({
    name,
    ...overrides,
  });
}

/**
 * Get a standardized agent configuration for basic testing
 * This ensures all tests use consistent agent settings for general testing
 */
export function getTestAgentConfig(name = 'test-agent', overrides: Partial<AgentConfig> = {}): AgentConfig {
  return AgentConfig.forTesting({
    name,
    ...overrides,
  });
}

/**
 * Get a standardized agent configuration for chat-only tests
 * This ensures all tests use consistent agent settings for chat interactions
 */
export function getChatAgentConfig(name = 'chat-test-agent', overrides: Partial<AgentConfig> = {}): AgentConfig {
  return AgentConfig.forChat({
    name,
    ...overrides,
  });
}

/**
 * Create and setup a local compute node for testing
 * This ensures all tests use a consistent local compute node configuration
 * @param name - Optional name for the compute node (default: 'test-shell-node')
 * @returns A configured and saved ComputeNode instance
 */
export async function get_local_compute_node(name = 'test-shell-node'): Promise<ComputeNode> {
  const computeNode = new ComputeNode({
    name,
    runtime: { name: 'test-runtime' },
    node_provider_type: ComputeProviderType.LOCAL_MACHINE,
    node_config: { launch: true },
    // Use an isolated temp dir so filesystem tests start with an empty directory
    // instead of the machine root (/). The Python backend respects this when set.
    fs_storage_mount_path: `/tmp/flow-test-${uuidv4()}`,
  });

  await computeNode.save();

  return computeNode;
}

// export const mockPendingMemberships: Membership[] = [];

// export const mockCreateMembership = vi
//   .spyOn(membershipService, 'createMembership')
//   .mockImplementation(async (typeId: TypeId, request: IMembershipRequest) => {
//     // Simulate adding a pending membership like the real backend
//     mockPendingMemberships.push({
//       user_id: `mock-user-${Date.now()}`, // Simulate a user ID
//       user_email: request.recipient_email,
//       role: request.invitation_targets[0].role, // Take role from first invitation target
//     } as Membership);
//   });

// vi.spyOn(membershipService, 'fetchPendingMemberships').mockImplementation(async () => {
//   return mockPendingMemberships;
// });

/**
 * Options for createAgenticProcess
 * Note: compute node is managed by backend Processor, not passed from frontend.
 */
export interface CreateAgenticProcessOptions {
  /** Name for the compute node (default: 'test-agentic-node') - used for backend setup */
  nodeName?: string;
  /** Permission mode for execution (default: 'bypassPermissions') */
  permissionMode?: PermissionMode;
  /** Max thinking tokens (default: 1024) */
  maxThinkingTokens?: number;
  /** Working directory */
  workdir?: string;
  /** LLM model override */
  model?: string;
}

/**
 * Result from createAgenticProcess containing all components needed for testing
 */
export interface AgenticProcessTestContext {
  /** The compute node */
  computeNode: ComputeNode;
  /** The agentic context for running instructions */
  context: AgenticContext;

  /**
   * Create an idle process ready for executeInstruction() calls.
   * This is the new recommended way to create processes for multi-turn conversations.
   * @returns AgenticProcess in IDLE status
   */
  createIdleProcess: () => Promise<AgenticProcess>;

  /**
   * Run an instruction with AMD format and collect all outputs.
   * @param instruction - Plain text instruction (will be wrapped in flow-do)
   * @returns Object with process, outputs array, and helper methods
   */
  run: (instruction: string) => Promise<AgenticProcessRunResult>;

  /**
   * Execute instruction content directly (no file parsing).
   * @param instruction - Plain text instruction
   * @returns Object with process, outputs array, and helper methods
   */
  execute: (instruction: string) => Promise<AgenticProcessRunResult>;

  /**
   * Dispose the processor and cleanup resources.
   */
  dispose: () => void;
}

/**
 * Result from running an agentic process
 */
export interface AgenticProcessRunResult {
  /** The agentic process entity */
  process: AgenticProcess;
  /** All collected FlowData outputs */
  outputs: FlowData[];
  /** Get outputs filtered by element type */
  getByType: (elementType: string) => FlowData[];
  /** Get combined content from chat outputs */
  getChatContent: () => string;
  /** Get combined content from reasoning outputs */
  getReasoningContent: () => string;
  /** Check if a user message was echoed */
  hasUserMessage: () => boolean;
}

/**
 * Create an agentic process test context with compute node and context ready for testing.
 *
 * This is the recommended way to set up agentic process tests. It handles:
 * - Creating a local compute node
 * - Setting up the context with sensible defaults
 * - Providing convenience methods for running instructions
 *
 * @param options - Optional configuration overrides
 * @returns Test context with computeNode, context, and helper methods
 *
 * @example
 * ```typescript
 * const { execute, dispose } = await createAgenticProcess();
 *
 * // Execute an instruction and get results
 * const { outputs, getChatContent, hasUserMessage } = await execute('Say hello');
 *
 * expect(hasUserMessage()).toBe(true);
 * expect(getChatContent()).toContain('hello');
 *
 * dispose();
 * ```
 */
export async function createAgenticProcess(
  options: CreateAgenticProcessOptions = {},
): Promise<AgenticProcessTestContext> {
  const {
    nodeName = 'test-agentic-node',
    permissionMode = 'bypassPermissions',
    maxThinkingTokens = 1024,
    workdir,
    model,
  } = options;

  // Create compute node
  const computeNode = await get_local_compute_node(nodeName);

  // Create context
  const context: AgenticContext = {
    permissionMode,
    maxThinkingTokens,
    workdir,
    model,
  };

  // Helper to collect outputs and create result
  const collectOutputs = async (process: AgenticProcess): Promise<AgenticProcessRunResult> => {
    const outputs: FlowData[] = [];
    for await (const flowData of process.output()) {
      outputs.push(flowData);
    }

    return {
      process,
      outputs,
      getByType: (elementType: string) => outputs.filter((o) => o.attributes?.['element-type'] === elementType),
      getChatContent: () =>
        outputs
          .filter((o) => o.attributes?.['element-type'] === 'chat')
          .map((o) => String(o.data))
          .join(''),
      getReasoningContent: () =>
        outputs
          .filter((o) => o.attributes?.['element-type'] === 'reasoning')
          .map((o) => String(o.data))
          .join(''),
      hasUserMessage: () =>
        outputs.some(
          (o) =>
            o.attributes?.['element-type'] === 'user-message' ||
            (o.attributes?.['element-type'] === 'chat' && o.attributes?.['role'] === 'user'),
        ),
    };
  };

  return {
    computeNode,
    context,

    createIdleProcess: async () => {
      return computeNode.createProcess(context);
    },

    run: async (instruction: string) => {
      const amdContent = `<!-- <flow-do> -->\n${instruction}\n<!-- </flow-do> -->`;
      const process = await computeNode.createProcess(context);
      await process.watch();
      await process.executeInstruction(amdContent, { sync: false });
      return collectOutputs(process);
    },

    execute: async (instruction: string) => {
      const process = await computeNode.createProcess(context);
      await process.watch();
      await process.executeInstruction(instruction, { sync: false });
      return collectOutputs(process);
    },

    dispose: () => {
      // Nothing to dispose — no processor
    },
  };
}
