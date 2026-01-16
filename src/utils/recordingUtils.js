let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = null;
let recordingPausedTime = 0;
let timerInterval = null;

export async function startRecording(canvasElement, audioTracks) {
  recordedChunks = [];
  recordingStartTime = Date.now();
  recordingPausedTime = 0;

  // get canvas stream
  const canvasStream = canvasElement.captureStream(30); // 30 FPS

  // add audio tracks
  if (audioTracks && audioTracks.length > 0) {
    audioTracks.forEach((track) => {
      canvasStream.addTrack(track);
    });
  }

  // create recorder
  const mimeType = 'video/webm;codecs=vp8';
  mediaRecorder = new MediaRecorder(canvasStream, { mimeType });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.start();
  console.log('Recording started');
  return { ok: true };
}

export function stopRecording() {
  return new Promise((resolve) => {
    if (!mediaRecorder) return resolve({ ok: false, error: 'No recorder' });

    if (timerInterval) clearInterval(timerInterval);

    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      recordedChunks = [];
      console.log('Recording stopped, blob size:', blob.size);
      resolve({ ok: true, blob });
    };

    mediaRecorder.stop();
  });
}

export function pauseRecording() {
  if (!mediaRecorder) return { ok: false, error: 'No recorder' };
  if (mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    recordingPausedTime = Date.now() - recordingStartTime;
    console.log('Recording paused');
    return { ok: true };
  }
  return { ok: false, error: 'Not recording' };
}

export function resumeRecording() {
  if (!mediaRecorder) return { ok: false, error: 'No recorder' };
  if (mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    recordingStartTime = Date.now() - recordingPausedTime;
    console.log('Recording resumed');
    return { ok: true };
  }
  return { ok: false, error: 'Not paused' };
}

export function startTimer(onTick) {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (recordingStartTime && mediaRecorder && mediaRecorder.state !== 'inactive') {
      const elapsed = Date.now() - recordingStartTime;
      const minutes = Math.floor(elapsed / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      if (onTick) onTick(timeStr);
    }
  }, 1000);
}

export function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

export function downloadRecording(blob, fileName = null) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || `interview-${Date.now()}.webm`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  console.log('Recording downloaded');
}

export async function uploadRecordingToServer(blob, fileName = null) {
  try {
    const formData = new FormData();
    formData.append('recording', blob);
    formData.append('fileName', fileName || `interview-${Date.now()}.webm`);

    const response = await fetch('http://localhost:3000/api/recordings', {
      method: 'POST',
      body: formData
    });

    if (response.ok) {
      const data = await response.json();
      console.log('Recording uploaded to server:', data);
      return { ok: true, data };
    } else {
      console.error('Server error:', response.status);
      return { ok: false, error: 'Server error' };
    }
  } catch (err) {
    console.error('Upload failed:', err);
    return { ok: false, error: err.message };
  }
}
