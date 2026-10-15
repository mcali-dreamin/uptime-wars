// A beat that keeps going in a hidden tab.
//
// Browsers stop requestAnimationFrame in a hidden tab and throttle its timers
// (down to once a minute after a while), but leave a dedicated Worker's timers
// alone. So the beat comes from a tiny inline Worker, with a plain interval as
// the fallback where Workers aren't available.

/** Call `beat` every `ms` milliseconds until the returned stop function runs. */
export function metronome(ms: number, beat: () => void): () => void {
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: "text/javascript" }));
    const worker = new Worker(url);
    worker.onmessage = () => beat();
    return () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const id = setInterval(beat, ms);
    return () => clearInterval(id);
  }
}
