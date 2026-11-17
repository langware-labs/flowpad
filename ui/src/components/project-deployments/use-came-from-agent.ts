import { useEffect, useState } from 'react';

/**
 * The agent the Deployments page was opened from (an agent's Deploy: `?deploy_main_agent=<id>`). The URL option
 * lives only while New deployment is open, and closing it clears the option; the page keeps the agent, so the
 * "Run on this computer" switch behind that dialog still places it as the local deployment's main agent.
 */
export function useCameFromAgent(preset: string | null): string | null {
  const [cameFrom, setCameFrom] = useState(preset);
  useEffect(() => {
    if (preset) setCameFrom(preset);
  }, [preset]);
  return preset ?? cameFrom;
}
