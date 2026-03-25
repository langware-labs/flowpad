import React from 'react';

type DotPulseProps = {
  className?: string;
};

export const DotPulse: React.FC<DotPulseProps> = ({ className = '' }) => {
  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <div className="h-1 w-1 animate-pulse rounded-full bg-primary" />
      <div className="h-1 w-1 animate-pulse rounded-full bg-primary" style={{ animationDelay: '0.2s' }} />
      <div className="h-1 w-1 animate-pulse rounded-full bg-primary" style={{ animationDelay: '0.4s' }} />
    </div>
  );
};
