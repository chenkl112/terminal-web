import { useCallback, useLayoutEffect, useRef } from 'react';

export function useChatScroll({ scrollerRef, contentRef, followRef, conversationId, visible, contentVersion, onNearBottom }) {
  const paused = useRef(false), interacting = useRef(false);
  const scrollToLatest = useCallback(() => {
    paused.current = false;
    followRef.current = true;
    onNearBottom(true);
    const element = scrollerRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [scrollerRef, followRef, onNearBottom]);

  useLayoutEffect(() => {
    if (visible) scrollToLatest();
  }, [conversationId, visible, scrollToLatest]);

  useLayoutEffect(() => {
    if (!visible || !followRef.current || paused.current || interacting.current) return;
    const element = scrollerRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [contentVersion, visible, scrollerRef, followRef]);

  useLayoutEffect(() => {
    const element = scrollerRef.current, content = contentRef.current;
    if (!visible || !element || !content) return;
    let frame = 0, intent = null, touchY = null, touchMoved = false;
    function pause() {
      paused.current = true; followRef.current = false; onNearBottom(false);
    }
    function schedule() {
      if (frame || !followRef.current || paused.current || interacting.current) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (followRef.current && !paused.current && !interacting.current) element.scrollTop = element.scrollHeight;
      });
    }
    function scroll() {
      // Layout shifts and browser scroll anchoring are not user navigation.
      if (interacting.current) return;
      if (paused.current) {
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
        if (atBottom && (intent === 'down' || intent === 'scrollbar')) {
          paused.current = false; followRef.current = true; onNearBottom(true);
        }
        return;
      }
      // Ignore layout-generated scrolls; an upward input pauses immediately.
      schedule();
    }
    function wheel(event) {
      if (!event.deltaY || event.ctrlKey || event.metaKey) return;
      intent = event.deltaY < 0 ? 'up' : 'down';
      if (event.deltaY < 0) pause();
      else scroll();
    }
    function touchStart(event) {
      touchY = event.touches[0]?.clientY ?? null; touchMoved = false;
      interacting.current = touchY != null;
    }
    function touchMove(event) {
      const next = event.touches[0]?.clientY;
      if (touchY == null || next == null || next === touchY) return;
      touchMoved = true; intent = next > touchY ? 'up' : 'down';
      if (next > touchY) pause();
      touchY = next;
    }
    function touchEnd() {
      touchY = null; interacting.current = false;
      if (touchMoved) scroll();
      schedule();
    }
    function pointerDown(event) {
      const rect = element.getBoundingClientRect();
      if (event.clientX >= rect.left + element.clientWidth) { intent = 'scrollbar'; interacting.current = true; pause(); }
    }
    function pointerUp() { if (touchY == null) { interacting.current = false; scroll(); schedule(); } }
    function keyDown(event) {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) {
        intent = 'up'; pause();
      } else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) {
        intent = 'down'; scroll();
      }
    }
    const observer = new ResizeObserver(schedule);
    observer.observe(element); observer.observe(content);
    element.addEventListener('scroll', scroll, { passive: true });
    element.addEventListener('wheel', wheel, { passive: true });
    element.addEventListener('touchstart', touchStart, { passive: true });
    element.addEventListener('touchmove', touchMove, { passive: true });
    element.addEventListener('touchend', touchEnd, { passive: true });
    element.addEventListener('touchcancel', touchEnd, { passive: true });
    element.addEventListener('pointerdown', pointerDown);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerUp);
    element.addEventListener('keydown', keyDown);
    element.addEventListener('load', schedule, true);
    document.fonts?.addEventListener('loadingdone', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      element.removeEventListener('scroll', scroll);
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('touchstart', touchStart);
      element.removeEventListener('touchmove', touchMove);
      element.removeEventListener('touchend', touchEnd);
      element.removeEventListener('touchcancel', touchEnd);
      element.removeEventListener('pointerdown', pointerDown);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerUp);
      element.removeEventListener('keydown', keyDown);
      element.removeEventListener('load', schedule, true);
      document.fonts?.removeEventListener('loadingdone', schedule);
      interacting.current = false;
    };
  }, [conversationId, visible, scrollerRef, contentRef, followRef, onNearBottom]);

  return scrollToLatest;
}
