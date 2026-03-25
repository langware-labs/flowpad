import React, { useEffect, useRef } from 'react';

const ParallaxBackground: React.FC = () => {
  const backgroundRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!backgroundRef.current) return;

      const x = e.clientX / window.innerWidth;
      const y = e.clientY / window.innerHeight;

      // Subtle movement based on mouse position
      backgroundRef.current.style.transform = `translate(${x * -10}px, ${y * -10}px)`;
    };

    window.addEventListener('mousemove', handleMouseMove);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 z-[-1] overflow-hidden">
      <div
        ref={backgroundRef}
        className="duration-3000 absolute inset-0 h-[110%] w-[110%] transition-transform ease-out"
        style={{
          background: `
            radial-gradient(circle at 20% 20%, rgba(15, 82, 215, 0.03), transparent 40%),
            radial-gradient(circle at 80% 80%, rgba(10, 52, 138, 0.03), transparent 40%)
          `,
          backgroundSize: '100% 100%',
        }}
      ></div>
    </div>
  );
};

export default ParallaxBackground;
