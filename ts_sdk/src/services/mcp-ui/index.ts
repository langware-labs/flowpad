/**
 * MCP UI SDK
 *
 * This module provides a complete SDK for creating and managing MCP UI components
 * following the official MCP Apps Extension (SEP-1865) specification.
 *
 * @example
 * ```typescript
 * import { mcpUIManager, MCPUIManager, MCPUIComponent } from '@your-org/flowpad-sdk';
 *
 * // Register HTML for a component
 * mcpUIManager.registerHTML('ui://my-app/main', '<html>...</html>');
 *
 * // Load and initialize the component
 * const component = await mcpUIManager.load('ui://my-app/main');
 *
 * // Show the component in a container
 * await component.show('main', '#my-container', { data: 'hello' });
 *
 * // Execute JavaScript in the iframe
 * const result = await component.eval('document.title');
 *
 * // Listen for events
 * component.on('message', (data) => console.log('Message:', data));
 *
 * // Close when done
 * await component.close();
 * ```
 */

export * from './types';
export * from './MCPUIComponent';
export * from './MCPUIManager';
export * from './MCPUIViewer';
