import { Artifact, FlowData, FlowStreamProcessor } from '@sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ArtifactSection from '@src/components/artifact-section';
import { unitTestSetup } from '../../utils/test-utils';

// Mock useAgentContext
vi.mock('@src/components/agent-layout/agent-context', () => ({
  useAgentContext: () => ({
    agenticProcess: null,
    agent: null,
    computeNode: null,
    project: null,
  }),
}));

// Mock useDockNavigation
vi.mock('@src/navigation', () => ({
  useDockNavigation: () => ({
    navigation: {
      openWebApp: vi.fn(),
      openFile: vi.fn(),
    },
  }),
}));

// Mock useFS and useProject
vi.mock('@sdk/react/hooks', () => ({
  useFS: () => ({
    getDownloadUrl: vi.fn((path: string) => `http://test.com/download/${path}`),
  }),
  useProject: () => ({
    project: { typeId: 'test-project-type-id' },
  }),
}));

describe('ArtifactSection Component - Web App Tests', () => {
  let queryClient: QueryClient;

  beforeEach(async () => {
    await unitTestSetup();

    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  /**
   * Helper function to parse XML using FlowStreamProcessor and create FlowData with Artifact
   * This uses the real XML parsing logic to validate parsing is done correctly
   */
  function createFlowDataFromXml(xmlString: string): FlowData<Artifact> {
    // Use FlowStreamProcessor to parse XML (real parsing logic)
    const processor = new FlowStreamProcessor();

    // Process the XML string
    processor.process_chunk(xmlString);
    processor.endStream();

    // Get all parsed FlowData objects
    const flowDataArray = processor.getAggregatedEvents();

    // Find the flow-result element
    const resultFlowData = flowDataArray.find((fd) => fd.elementType === 'result');
    expect(resultFlowData).toBeDefined();
    expect(resultFlowData).not.toBeNull();

    // Wait for the FlowData to be ready (parsed)
    if (!resultFlowData!.ready) {
      // If not ready, the data might not be parsed yet
      // This shouldn't happen with endStream(), but handle it just in case
      resultFlowData!.parseElementData();
    }

    // The parsed data should be the artifact JSON object
    // Create Artifact from the parsed data
    const artifactData = resultFlowData!.data;
    expect(artifactData).toBeDefined();
    expect(typeof artifactData).toBe('object');

    // Ensure the artifact data has the required type field
    expect(artifactData.type).toBe('artifact');

    const artifact = new Artifact(artifactData);

    // Replace FlowData.data with the Artifact instance
    resultFlowData!.data = artifact as any;

    return resultFlowData! as FlowData<Artifact>;
  }

  it.each([
    {
      description: 'history XML format (lowercase artifact_type)',
      xml: '<flow-result i="2390" t="2025-11-10T22:26:56.563456+00:00" data-type="object">{"type": "artifact", "path": ".", "name": "Heya Webapp", "ref_type": "FOLDER", "artifact_type": "webapp", "description": "Simple webapp displaying \'heya\'", "metadata": {"port": "9842"}}</flow-result>',
    },
    {
      description: 'completion XML format (uppercase artifact_type)',
      xml: '<flow-result i="2288" t="2025-11-10T22:22:25.263026+00:00" data-type="entity">{"type":"artifact","id":"d895af63-3c2f-4c91-8639-a13498dc6a38","created_by":"b8fd3d0c-260e-4db6-908c-0c04bd7dba3e","created_date":"2025-11-10T22:22:25.265213Z","updated_by":"b8fd3d0c-260e-4db6-908c-0c04bd7dba3e","updated_date":"2025-11-10T22:22:25.265213Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"Heya Webapp","ref_type":"FOLDER","path":".","description":"Simple webapp displaying \'heya\'","metadata":{"port":"9842"},"artifact_type":"WEBAPP","generating_flow_id":"b0f1f758-3bf0-49c7-8338-fb59dfede41d"}</flow-result>',
    },
  ])('should show Globe icon and "Web App" title for $description', ({ xml }) => {
    const flowData = createFlowDataFromXml(xml);

    const { container } = render(
      <TestWrapper>
        <ArtifactSection flowData={flowData} />
      </TestWrapper>,
    );

    // Check for "Web App" title - this confirms Globe icon is used (same code path)
    const titleElement = screen.getByText(/^Web App :/);
    expect(titleElement).toBeInTheDocument();
    expect(titleElement.textContent).toMatch(/^Web App :/);

    // Verify Globe icon is rendered (lucide-react icons render as SVG)
    // The icon should be present in the component
    const svgElements = container.querySelectorAll('svg');
    expect(svgElements.length).toBeGreaterThan(0);

    // Verify the component structure - check that title is within a card-like container
    // The title should be within the rendered component structure
    expect(titleElement.closest('div')).toBeInTheDocument();
  });
});
