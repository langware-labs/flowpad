import React, { useEffect, useState } from 'react';
import Confetti from 'react-confetti';

const MAX_STATUS_WORDS = 4;

interface StatusMessageProps {
  status: string;
  isStreaming: boolean;
  showConfettiOnce: boolean;
}

// Truncate status text if it exceeds the maximum word count
const truncateStatus = (status: string): string => {
  const words = status.trim().split(/\s+/);
  if (words.length <= MAX_STATUS_WORDS) {
    return status;
  }
  return words.slice(0, MAX_STATUS_WORDS).join(' ') + '...';
};

// Simple animated spinner component
const Spinner = () => {
  return (
    <div
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-solid border-current border-r-transparent motion-reduce:animate-[spin_1.5s_linear_infinite]"
      role="status"
    >
      <span className="sr-only">Loading status...</span>
    </div>
  );
};

const StatusMessage: React.FC<StatusMessageProps> = ({ status, isStreaming, showConfettiOnce }) => {
  const [isShownOnce, setIsShownOnce] = useState(false);
  const [isConfettiShownOnce, setIsConfettiShownOnce] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [windowSize, setWindowSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  useEffect(() => {
    // Show confetti once, if browser was shown and streaming ended
    if (isShownOnce || isStreaming || !isConfettiShownOnce) {
      return;
    }
    setIsShownOnce(true);
    setShowConfetti(true);
    setTimeout(() => setShowConfetti(false), 8000); // Hide confetti after 8 seconds
  }, [isShownOnce, isStreaming, isConfettiShownOnce]);

  useEffect(() => {
    if (showConfettiOnce) {
      setIsConfettiShownOnce(true);
    }
  }, [showConfettiOnce]);

  useEffect(() => {
    const handleResize = () => {
      setWindowSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <>
      {showConfetti && (
        <Confetti
          width={windowSize.width}
          height={windowSize.height}
          recycle={false}
          numberOfPieces={200}
          gravity={0.2}
        />
      )}
      <div
        data-testid="status-message"
        className={`px-2 py-0 transition-all duration-500 ease-in-out ${status ? 'max-h-20 opacity-100' : 'max-h-0 opacity-0'} `}
      >
        <div className="my-0 flex min-h-0 w-fit items-center gap-2 overflow-hidden rounded-lg border px-2 text-sm text-gray-600">
          <span className="mr-2">Status:</span>
          {isStreaming && <Spinner />}
          <span>{isStreaming ? truncateStatus(status) : 'Ready'}</span>
        </div>
      </div>
    </>
  );
};

export default StatusMessage;
