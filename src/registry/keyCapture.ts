let claims = 0;

export function beginKeyCapture(): () => void {
  claims += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims -= 1;
  };
}

export function keyCaptureActive(): boolean {
  return claims > 0;
}
