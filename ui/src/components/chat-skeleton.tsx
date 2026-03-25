import { Skeleton } from '@src/components/ui/skeleton';
import React from 'react';

const ChatSkeleton: React.FC = () => {
  return (
    <div className="space-y-2">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/4" />
    </div>
  );
};

export default ChatSkeleton;
