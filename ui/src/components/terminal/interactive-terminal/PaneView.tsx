import React from 'react';

export interface PaneViewProps {
  children: React.ReactNode;
}

export const PaneView: React.FC<PaneViewProps> = ({ children }) => {
  return <div className="flex min-h-0 flex-1">{children}</div>;
};
