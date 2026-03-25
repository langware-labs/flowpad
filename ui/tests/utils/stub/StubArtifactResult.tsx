import { Flow, FlowExecutionStatus } from '@sdk';
import { useCurrentArtifacts, useProcessExecution } from '@src/hooks/flow-hooks';
import React from 'react';

interface ArtifactResultProps {
  flow: Flow | null;
  executionTime?: number | null;
}

/**
 * Renders flow execution results, especially artifacts
 * Uses useCurrentArtifacts hook to get artifact data
 */
export const ArtifactResult: React.FC<ArtifactResultProps> = ({ flow, executionTime }) => {
  // Use hooks to get artifacts and execution state
  const { data: artifacts } = useCurrentArtifacts();
  const { executionState } = useProcessExecution(flow);

  const result = artifacts.length > 0 ? artifacts[artifacts.length - 1] : null;
  const results = artifacts;
  const resultCount = artifacts.length;
  const isComplete = executionState === FlowExecutionStatus.Ready;

  if (result && results.length === 0) {
    return null;
  }

  // Handle different result types
  const renderResult = () => {
    if (!result) {
      return null;
    }

    // Artifact result
    if (result.artifact_id || result.path || result.content) {
      return (
        <div data-testid="artifact-result" className="border rounded-lg p-4 bg-green-50">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-3 h-3 bg-green-500 rounded-full" />
            <span className="font-semibold text-green-700">Artifact Created</span>
            {isComplete && (
              <span data-testid="completion-badge" className="text-xs bg-green-200 px-2 py-1 rounded">
                Complete
              </span>
            )}
          </div>

          {result.artifact_id && (
            <div data-testid="artifact-id" className="text-sm">
              <span className="font-medium">ID: </span>
              {result.artifact_id}
            </div>
          )}

          {result.path && (
            <div data-testid="artifact-path" className="text-sm">
              <span className="font-medium">Path: </span>
              <code className="bg-gray-100 px-1 rounded">{result.path}</code>
            </div>
          )}

          {result.content && (
            <div data-testid="artifact-content" className="mt-2">
              <div className="font-medium text-sm mb-1">Content:</div>
              <pre className="text-xs bg-white p-2 rounded border overflow-x-auto">
                {typeof result.content === 'string' ? result.content : JSON.stringify(result.content, null, 2)}
              </pre>
            </div>
          )}

          {result.type && (
            <div data-testid="artifact-type" className="text-xs text-gray-600 mt-2">
              Type: {result.type}
            </div>
          )}
        </div>
      );
    }

    // Generic result
    return (
      <div data-testid="generic-result" className="border rounded-lg p-4 bg-blue-50">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-3 h-3 bg-blue-500 rounded-full" />
          <span className="font-semibold text-blue-700">Result</span>
          {isComplete && (
            <span data-testid="completion-badge" className="text-xs bg-blue-200 px-2 py-1 rounded">
              Complete
            </span>
          )}
        </div>

        <pre data-testid="result-content" className="text-sm bg-white p-2 rounded border overflow-x-auto">
          {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
        </pre>
      </div>
    );
  };

  return (
    <div data-testid="flow-result-container" className="mt-4">
      {/* Results Summary Table */}
      {results.length > 0 && (
        <div data-testid="result-table" className="mb-4">
          <h4 className="font-semibold text-sm mb-2">Results ({resultCount} total)</h4>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left border-b">Index</th>
                  <th className="px-3 py-2 text-left border-b">Type</th>
                  <th className="px-3 py-2 text-left border-b">ID</th>
                  <th className="px-3 py-2 text-left border-b">Path/Name</th>
                  <th className="px-3 py-2 text-left border-b">Properties</th>
                </tr>
              </thead>
              <tbody>
                {results.map((res, index) => (
                  <tr key={index} data-testid={`result-row-${index}`} className="border-b last:border-b-0">
                    <td className="px-3 py-2" data-testid={`result-index-${index}`}>
                      {index}
                    </td>
                    <td className="px-3 py-2" data-testid={`result-type-${index}`}>
                      {res.type || res.constructor?.name || 'Unknown'}
                    </td>
                    <td className="px-3 py-2" data-testid={`result-id-${index}`}>
                      {res.id || res.artifact_id || 'N/A'}
                    </td>
                    <td className="px-3 py-2" data-testid={`result-path-${index}`}>
                      {res.path || res.name || 'N/A'}
                    </td>
                    <td className="px-3 py-2" data-testid={`result-props-${index}`}>
                      {Object.keys(res).length} props
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Latest Result Detail */}
      {result && renderResult()}

      {/* Execution metadata */}
      <div data-testid="execution-metadata" className="mt-2 text-xs text-gray-500 flex gap-4">
        <span data-testid="completion-status">Status: {isComplete ? 'Complete' : 'In Progress'}</span>
        <span data-testid="result-count">Results: {resultCount}</span>
        {executionTime && <span data-testid="execution-time">Duration: {executionTime}s</span>}
      </div>
    </div>
  );
};
