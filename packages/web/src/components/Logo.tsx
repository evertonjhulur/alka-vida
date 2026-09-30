import { useState } from 'react';

/**
 * The owner's logo file (the one beside the launcher that the PDFs use),
 * served by /api/logo. Without one, the name set in type, so nothing is ever
 * a broken image.
 */
export default function Logo({ height = 56, className }: { height?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className={`wordmark ${className ?? ''}`} style={{ fontSize: Math.round(height * 0.5) }}>
        Alka Vida
      </span>
    );
  }
  return (
    <img src="/api/logo" alt="Alka Vida alkaline drinking water" className={className}
         style={{ height, width: 'auto' }} onError={() => setFailed(true)} />
  );
}
