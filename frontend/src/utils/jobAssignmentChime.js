let audioContext = null;

export const playJobAssignmentChime = () => {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate([70, 45, 110]);
  }

  if (typeof window === 'undefined') return;
  const AudioContextType = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextType) return;

  try {
    audioContext ||= new AudioContextType();
    if (audioContext.state === 'suspended') void audioContext.resume();

    const startAt = audioContext.currentTime + 0.02;
    [660, 880].forEach((frequency, index) => {
      const start = startAt + index * 0.14;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.13);
    });
  } catch {
    // Audio or vibration can be unavailable or blocked by browser policy.
  }
};