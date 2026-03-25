import { AgentConfig } from '@sdk';
import { describe, expect, it } from 'vitest';

describe('AgentConfig TypeScript class validation', () => {
  it('should construct agent config with modified values from defaults', () => {
    // Create agent config with modified config from defaults
    const agentConfig = new AgentConfig({
      name: 'test-config-agent',
      agent_config: {
        worker_type: 'claude_code' as any,
        execution_enabled: true,
        planning_enabled: false,
        base_skill: 'code_migrator' as any,
        checkpoint_mode: 'approve' as any,
        search: {
          search_mode: 'deep' as any,
          num_results: 5,
          max_output_tokens: 8000,
        },
      },
    });

    // Validate AgentConfig class properties
    expect(agentConfig.name).toBe('test-config-agent');
    expect(agentConfig.agent_config.worker_type).toBe('claude_code');
    expect(agentConfig.agent_config.execution_enabled).toBe(true);
    expect(agentConfig.agent_config.planning_enabled).toBe(false);
    expect(agentConfig.agent_config.base_skill).toBe('code_migrator');
    expect(agentConfig.agent_config.checkpoint_mode).toBe('approve');
    expect(agentConfig.agent_config.search.search_mode).toBe('deep');
    expect(agentConfig.agent_config.search.num_results).toBe(5);
    expect(agentConfig.agent_config.search.max_output_tokens).toBe(8000);
    expect(agentConfig.enabled).toBe(true);

    // Test toAgentConstructor method produces correct format
    const constructorData = agentConfig.toAgentConstructor();
    expect(constructorData.name).toBe('test-config-agent');
    expect(constructorData.agent_config.worker_type).toBe('claude_code');
    expect(constructorData.agent_config.execution_enabled).toBe(true);
    expect(constructorData.agent_config.planning_enabled).toBe(false);
    expect(constructorData.agent_config.base_skill).toBe('code_migrator');
    expect(constructorData.agent_config.checkpoint_mode).toBe('approve');
    expect(constructorData.agent_config.search.search_mode).toBe('deep');
    expect(constructorData.agent_config.search.num_results).toBe(5);
    expect(constructorData.agent_config.search.max_output_tokens).toBe(8000);
    expect(constructorData.enabled).toBe(true);
  });

  it('should use factory methods correctly', () => {
    // Test execution factory method without overriding worker_type
    const executionConfig = AgentConfig.forExecution({
      name: 'execution-test',
    });

    expect(executionConfig.name).toBe('execution-test');
    expect(executionConfig.agent_config.worker_type).toBe('pydantic_ai');
    expect(executionConfig.agent_config.execution_enabled).toBe(true);
    expect(executionConfig.agent_config.planning_enabled).toBe(false);
    expect(executionConfig.agent_config.search.num_results).toBe(1);
    expect(executionConfig.agent_config.search.max_output_tokens).toBe(8000);

    // Test chat factory method
    const chatConfig = AgentConfig.forChat({
      name: 'chat-test',
    });

    expect(chatConfig.name).toBe('chat-test');
    expect(chatConfig.agent_config.worker_type).toBe('simple');
    expect(chatConfig.agent_config.execution_enabled).toBe(false);
    expect(chatConfig.agent_config.planning_enabled).toBe(false);

    // Test testing factory method
    const testConfig = AgentConfig.forTesting({
      name: 'test-agent',
    });

    expect(testConfig.name).toBe('test-agent');
    expect(testConfig.agent_config.worker_type).toBe('pydantic_ai');
    expect(testConfig.agent_config.execution_enabled).toBe(true);
    expect(testConfig.agent_config.planning_enabled).toBe(false);
  });
});
