import { FlowData } from '@sdk';
import { cn } from '@src/lib/utils';
import React from 'react';

interface ErrorSectionProps {
  flowData: FlowData;
  className?: string;
}

const ErrorSection: React.FC<ErrorSectionProps> = ({ flowData, className }) => {
  const errorMessage = flowData?.data || flowData?.content || 'Unknown error occurred';

  if (!flowData) {
    console.error('ErrorSection: Invalid flowData');
    return null;
  }

  return (
    <div
      className={cn('border-l-2 border-l-red-500 bg-red-50 px-3 py-2 font-mono dark:bg-red-950/30', className)}
      data-testid="error-section"
    >
      {/* Terminal-style error header */}
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-red-600 dark:text-red-400">✗ error</span>
      </div>

      {/* Error content */}
      <pre className="whitespace-pre-wrap text-[12px] leading-relaxed text-red-700 dark:text-red-300">
        {errorMessage}
      </pre>
    </div>
  );
};

export default ErrorSection;
