import React, { forwardRef, useEffect, useRef, useState } from 'react';

// Streaming Markdown replaces DOM nodes. Keep the touched subtree stable until
// the gesture ends so native scrolling and touchend keep their original target.
export default forwardRef(function ChatContent({ children }, ref) {
  const held = useRef(false), rendered = useRef(children);
  const [, refresh] = useState(0);
  if (!held.current) rendered.current = children;
  function release() {
    if (!held.current) return;
    held.current = false; refresh(value => value + 1);
  }
  useEffect(() => {
    window.addEventListener('blur', release);
    return () => window.removeEventListener('blur', release);
  }, []);
  return <div ref={ref} className="message-content" onTouchStartCapture={() => { held.current = true; }} onTouchEndCapture={release} onTouchCancelCapture={release}>{rendered.current}</div>;
});
