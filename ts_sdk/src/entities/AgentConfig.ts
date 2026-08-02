import { CheckpointMode, SearchMode, WorkerType } from './subagent';

/**
 * Default SubAgent Configuration with sensible defaults for testing and production
 * Use this class to ensure consistent agent configuration across the application
 */
export class AgentConfig {
  public name: string;
  public agent_config: {
    search: {
      search_mode: SearchMode;
      num_results: number;
      max_output_tokens: number;
    };
    checkpoint_mode: CheckpointMode;
    worker_type?: WorkerType;
    planning_enabled?: boolean;
    execution_enabled?: boolean;
  };
  public site_config: {
    domain?: string;
    branding: {
      company_name: string;
      logo_url: string;
      use_brightness_filter: boolean;
      placeholder: string;
    };
    colors: {
      primary_color: string;
    };
    content: {
      badge: string;
      header: string;
      subheader: string;
      placeholder: string;
    };
    feature_flags?: {
      enable_escalation: boolean;
      require_login: boolean;
    };
  };
  public enabled: boolean;

  constructor(overrides: Partial<AgentConfig> = {}) {
    // Set all defaults
    this.name = overrides.name || 'default-agent';
    this.enabled = overrides.enabled ?? true;

    this.agent_config = {
      search: {
        search_mode: SearchMode.FAST,
        num_results: 3,
        max_output_tokens: 5000,
        ...overrides.agent_config?.search,
      },
      checkpoint_mode: CheckpointMode.AUTO,
      worker_type: WorkerType.AUTO,
      planning_enabled: false,
      execution_enabled: true,
      ...overrides.agent_config,
    };

    this.site_config = {
      domain: 'flowpad.ai',
      branding: {
        company_name: 'Flowpad',
        logo_url: 'logo.png',
        use_brightness_filter: true,
        placeholder: '',
        ...overrides.site_config?.branding,
      },
      colors: {
        primary_color: '#4f46e5',
        ...overrides.site_config?.colors,
      },
      content: {
        badge: '',
        header: '',
        subheader: '',
        placeholder: '',
        ...overrides.site_config?.content,
      },
      feature_flags: {
        enable_escalation: false,
        require_login: false,
        ...overrides.site_config?.feature_flags,
      },
      ...overrides.site_config,
    };
  }

  /**
   * Get a configuration optimized for code execution and file creation
   */
  static forExecution(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return new AgentConfig({
      name: 'execution-agent',
      agent_config: {
        search: {
          search_mode: SearchMode.FAST,
          num_results: 1,
          max_output_tokens: 8000,
        },
        checkpoint_mode: CheckpointMode.AUTO,
        worker_type: WorkerType.PYDANTIC_AI,
        planning_enabled: false, // Default to planning disabled
        execution_enabled: true, // Enable execution for code tasks
        ...overrides.agent_config,
      },
      site_config: {
        branding: {
          company_name: 'Flowpad',
          logo_url: 'logo.png',
          use_brightness_filter: true,
          placeholder: '',
        },
        colors: {
          primary_color: '#4f46e5',
        },
        content: {
          badge: '',
          header: '',
          subheader: '',
          placeholder: '',
        },
        feature_flags: {
          enable_escalation: false,
          require_login: false,
        },
        ...overrides.site_config,
      },
      ...overrides,
    });
  }

  /**
   * Get a configuration optimized for simple chat interactions
   */
  static forChat(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return new AgentConfig({
      name: 'chat-agent',
      agent_config: {
        search: {
          search_mode: SearchMode.FAST,
          num_results: 1,
          max_output_tokens: 3000,
        },
        checkpoint_mode: CheckpointMode.AUTO,
        worker_type: WorkerType.SIMPLE,
        planning_enabled: false,
        execution_enabled: false, // Simple chat doesn't need execution
        ...overrides.agent_config,
      },
      ...overrides,
    });
  }

  /**
   * Get a configuration optimized for testing
   */
  static forTesting(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return new AgentConfig({
      name: 'test-agent',
      agent_config: {
        search: {
          search_mode: SearchMode.FAST,
          num_results: 1,
          max_output_tokens: 5000,
        },
        checkpoint_mode: CheckpointMode.AUTO,
        worker_type: WorkerType.PYDANTIC_AI,
        planning_enabled: false,
        execution_enabled: true, // Enable execution for testing
        ...overrides.agent_config,
      },
      site_config: {
        branding: {
          company_name: 'Flowpad',
          logo_url: 'logo.png',
          use_brightness_filter: true,
          placeholder: '',
        },
        colors: {
          primary_color: '#4f46e5',
        },
        content: {
          badge: '',
          header: '',
          subheader: '',
          placeholder: '',
        },
        feature_flags: {
          enable_escalation: false,
          require_login: false,
        },
        ...overrides.site_config,
      },
      ...overrides,
    });
  }

  /**
   * Convert to the format expected by the SubAgent constructor
   */
  toAgentConstructor() {
    return {
      name: this.name,
      agent_config: this.agent_config,
      site_config: this.site_config,
      enabled: this.enabled,
    };
  }
}
