import { FlowData } from '@sdk';

/**
 * Create a user input FlowData
 */
export function createUserFlowData(content: string): FlowData {
  return new FlowData('user-input', content, {
    role: 'user',
    timestamp: new Date().toISOString(),
    source: 'user-input',
  });
}
