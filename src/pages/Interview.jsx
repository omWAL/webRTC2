import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import socket from '../socket';
import DebugPanel from '../components/DebugPanel';
import {
  startRecording,
  stopRecording,
  pauseRecording,
  resumeRecording,
  startTimer,
  stopTimer,
  downloadRecording,
  uploadRecordingToServer
} from '../utils/recordingUtils';

export default function Interview() {
  const localVideoRef = useRef();
  const hostVideoRef = useRef();
  const screenVideoRef = useRef();
  const [pc, setPc] = useState(null);
  const pcRef = useRef(null);
  const [localStream, setLocalStream] = useState(null);
  const localStreamRef = useRef(null);
  const [screenSharing, setScreenSharing] = useState(false);
  const [screenStream, setScreenStream] = useState(null);
  const [hostSharing, setHostSharing] = useState(false);
  const navigate = useNavigate();

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState('00:00');
  const recordingCanvasRef = useRef(null);

  function stopLocalAndCleanup() {
    try { if (screenStream) screenStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { if (localStreamRef.current) localStreamRef.current.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { if (pcRef.current) { pcRef.current.close(); pcRef.current = null; } } catch (e) {}
    setScreenSharing(false);
    setHostSharing(false);
    setLocalStream(null);
    localStreamRef.current = null;
    setPc(null);
  }

  useEffect(() => {
    const hostId = sessionStorage.getItem('hostId');
    if (!hostId) return navigate('/join');

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    setPc(peer);
    pcRef.current = peer;

    // send local tracks
    async function startLocal() {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      stream.getTracks().forEach((t) => {
        console.log('Adding local track', t.kind, t.label);
        peer.addTrack(t, stream);
      });
    }

    // Simple ontrack handler - attach immediately
    peer.ontrack = (ev) => {
      console.log('Candidate got ontrack event', ev.track.kind, ev.track.id);
      let stream = ev.streams && ev.streams[0];
      if (!stream) {
        stream = new MediaStream();
        if (ev.track) stream.addTrack(ev.track);
      }
      
      const audioCount = stream.getAudioTracks().length;
      const videoCount = stream.getVideoTracks().length;
      pushLog('Candidate ontrack: audio=' + audioCount + ' video=' + videoCount + ' trackKind=' + ev.track.kind);
      
      // Simple heuristic: if no audio tracks, treat as screen share
      const isScreen = audioCount === 0 && videoCount > 0;
      
      if (isScreen) {
        pushLog('Candidate: attaching to host screen element');
        if (screenVideoRef.current) screenVideoRef.current.srcObject = stream;
        setHostSharing(true);
      } else {
        pushLog('Candidate: attaching to host camera element');
        if (hostVideoRef.current) hostVideoRef.current.srcObject = stream;
      }
      
      remoteStreams.set(stream.id || ev.track.id, { type: isScreen ? 'screen' : 'camera', stream });
    };

    peer.oniceconnectionstatechange = () => {
      console.log('Candidate pc state', peer.connectionState, peer.iceConnectionState);
    };

    startLocal();

    // ICE candidate handling
    peer.onicecandidate = (e) => {
      if (e.candidate) {
        console.log('Candidate sending ICE to host', hostId, e.candidate);
        socket.emit('webrtc_ice', { to: hostId, candidate: e.candidate });
      }
    };

    // receive answer
    socket.on('webrtc_answer', async ({ from, sdp }) => {
      pushLog('Candidate received answer from ' + from);
      try {
        await peer.setRemoteDescription(new RTCSessionDescription(sdp));
        pushLog('Candidate set remote description after answer');
      } catch (err) {
        pushLog('Failed to set remote description on candidate: ' + err.message);
      }
    });

    // receive offer (host may initiate renegotiation for screen or other tracks)
    socket.on('webrtc_offer', async ({ from, sdp }) => {
      console.log('Candidate received offer from', from);
      try {
        await peer.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit('webrtc_answer', { to: from, sdp: answer });
        console.log('Candidate sent answer to', from);
      } catch (err) {
        console.error('Candidate failed to handle offer', err);
      }
    });

    // receive ICE from host
    socket.on('webrtc_ice', async ({ candidate }) => {
      console.log('Candidate received ICE', candidate);
      try {
        await peer.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('Failed to add ICE candidate', err);
      }
    });

    // Negotiation management (polite peer) to handle glare
    const makingOffer = { current: false };
    const ignoreOffer = { current: false };
    const polite = false; // candidate is impolite in this simple scheme

    peer.onnegotiationneeded = async () => {
      try {
        pushLog('Candidate negotiationneeded - creating offer');
        makingOffer.current = true;
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        // log senders
        pushLog('Candidate senders: ' + peer.getSenders().map((s) => s.track && s.track.id).join(','));
        socket.emit('webrtc_offer', { to: hostId, sdp: offer });
      } catch (err) {
        console.error('Candidate negotiation failed', err);
      } finally {
        makingOffer.current = false;
      }
    };

    // create offer to host (initial)
    async function createOffer() {
      try {
        pushLog('Candidate creating offer to host ' + hostId);
        makingOffer.current = true;
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        pushLog('Candidate senders (createOffer): ' + peer.getSenders().map((s) => s.track && s.track.id).join(','));
        socket.emit('webrtc_offer', { to: hostId, sdp: offer });
      } catch (err) {
        pushLog('Candidate createOffer failed: ' + err.message);
      } finally {
        makingOffer.current = false;
      }
    }

    // handle incoming offers with polite check
    socket.on('webrtc_offer', async ({ from, sdp }) => {
      pushLog('Candidate received offer from ' + from);
      const offer = new RTCSessionDescription(sdp);
      const readyForOffer = !makingOffer.current && (peer.signalingState === 'stable');
      const offerCollision = !readyForOffer;
      if (offerCollision) {
        pushLog('Candidate detected offer collision, polite=' + polite);
      }
      if (offerCollision && !polite) {
        pushLog('Candidate ignoring offer due to collision');
        return;
      }
      try {
        await peer.setRemoteDescription(offer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit('webrtc_answer', { to: from, sdp: answer });
        pushLog('Candidate sent answer to ' + from);
      } catch (err) {
        pushLog('Candidate failed to handle offer: ' + err.message);
      }
    });

    // Wait for host to be ready before creating offer. Host will emit 'host_ready'.
    socket.on('host_ready', ({ from }) => {
      console.log('Candidate received host_ready from', from);
      createOffer();
    });

    // Fallback in case 'host_ready' is missed
    const fallbackOffer = setTimeout(() => {
      console.warn('Fallback: creating offer after timeout');
      createOffer();
    }, 3000);

    socket.on('interview_ended', () => {
      // cleanup and go back
      stopLocalAndCleanup();
      navigate('/join');
    });

    return () => {
      clearTimeout(fallbackOffer);
      socket.off('webrtc_answer');
      socket.off('webrtc_offer');
      socket.off('webrtc_ice');
      socket.off('interview_ended');
      socket.off('host_ready');
      try { if (pcRef.current) { pcRef.current.close(); pcRef.current = null; } } catch (e) {}
    };
  }, []);

  // keep reference to the sender used for screen sharing so we can remove it later
  const screenSenderRef = useRef(null);
  const [logs, setLogs] = useState([]);
  function pushLog(msg) {
    setLogs((s) => [...s, `${new Date().toLocaleTimeString()} - ${msg}`]);
    console.log(msg);
  }

  async function toggleScreen() {
    if (!pc) return pushLog('PC not ready for screen share');
    if (!screenSharing) {
      try {
        pushLog('Candidate starting screen share...');
        const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
        setScreenStream(s);
        // add screen track as a separate sender so host can show camera + screen
        const screenTrack = s.getVideoTracks()[0];
        const sender = pc.addTrack(screenTrack, s);
        screenSenderRef.current = sender;
        pushLog('Candidate added screen sender, forcing negotiation to host');

        // inform host explicitly that candidate started sharing (helps host classify)
        const hostId = sessionStorage.getItem('hostId');
        socket.emit('screen_share_started', { to: hostId });

        // ensure renegotiation: create offer and send to host
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('webrtc_offer', { to: hostId, sdp: offer });
          pushLog('Candidate sent offer after adding screen');
        } catch (err) {
          pushLog('Candidate failed to send offer after adding screen: ' + (err.message || err));
        }

        screenTrack.onended = () => {
          pushLog('Candidate screen track ended');
          stopScreenSharing();
        };

        setScreenSharing(true);
      } catch (err) {
        pushLog('Could not start screen share: ' + (err.message || err));
      }
    } else {
      pushLog('Candidate stopping screen share');
      stopScreenSharing();
      // renegotiate to remove screen
      try {
        const hostId = sessionStorage.getItem('hostId');
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc_offer', { to: hostId, sdp: offer });
        pushLog('Candidate sent offer after stopping screen');
      } catch (err) {
        pushLog('Candidate failed to send offer after stopping screen: ' + (err.message || err));
      }
    }
  }
  function stopScreenSharing() {
    if (!pc) return;
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    // remove the screen sender if present
    try {
      const sender = screenSenderRef.current;
      if (sender) {
        pc.removeTrack(sender);
        try { sender.track.stop(); } catch (e) {}
        screenSenderRef.current = null;
      }
    } catch (err) {
      console.warn('Failed to remove screen sender', err);
    }

    // inform host explicitly that candidate stopped sharing
    try {
      const hostId = sessionStorage.getItem('hostId');
      socket.emit('screen_share_stopped', { to: hostId });
    } catch (e) {}

    // no need to revert camera since camera sender still exists
    setScreenStreamingFalse();
  }

  function setScreenStreamingFalse() {
    setScreenSharing(false);
    setScreenStream(null);
  }

  async function handleToggleRecording() {
    if (!isRecording) {
      try {
        setIsRecording(true);
        setIsRecordingPaused(false);
        pushLog('Starting video recording...');
        await startRecording(recordingCanvasRef.current, [localStreamRef.current?.getAudioTracks()[0]].filter(Boolean));
        startTimer(setRecordingTime);
      } catch (err) {
        pushLog('Failed to start recording: ' + err.message);
        setIsRecording(false);
      }
    } else {
      try {
        pushLog('Stopping video recording...');
        stopTimer();
        const { ok, blob } = await stopRecording();
        if (ok) {
          downloadRecording(blob, `candidate-interview-${Date.now()}.webm`);
          pushLog('Recording downloaded successfully');
        }
        setIsRecording(false);
        setIsRecordingPaused(false);
        setRecordingTime('00:00');
      } catch (err) {
        pushLog('Failed to stop recording: ' + err.message);
      }
    }
  }

  function handleTogglePauseRecording() {
    if (isRecordingPaused) {
      const { ok } = resumeRecording();
      if (ok) {
        setIsRecordingPaused(false);
        startTimer(setRecordingTime);
        pushLog('Recording resumed');
      }
    } else {
      const { ok } = pauseRecording();
      if (ok) {
        setIsRecordingPaused(true);
        stopTimer();
        pushLog('Recording paused');
      }
    }
  }

  async function handleUploadRecording() {
    try {
      if (isRecording) {
        pushLog('Please stop recording before uploading');
        return;
      }
      pushLog('Uploading recording to server...');
    } catch (err) {
      pushLog('Upload failed: ' + err.message);
    }
  }

  useEffect(() => {
    if (recordingCanvasRef.current) {
      const canvas = recordingCanvasRef.current;
      // Larger canvas to match actual visual layout
      // Layout: 3 videos (320x240 each) side by side with 20px gap = 960 + 40 = 1000px wide, 240px high
      canvas.width = 1000;
      canvas.height = 280;
      const ctx = canvas.getContext('2d');
      
      const drawFrame = () => {
        // Clear canvas
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Draw local video at (0, 0)
        if (localVideoRef.current && localVideoRef.current.readyState === localVideoRef.current.HAVE_ENOUGH_DATA) {
          ctx.drawImage(localVideoRef.current, 0, 0, 320, 240);
        }
        
        // Draw host camera at (340, 0) [320 + 20 gap]
        if (hostVideoRef.current && hostVideoRef.current.readyState === hostVideoRef.current.HAVE_ENOUGH_DATA) {
          ctx.drawImage(hostVideoRef.current, 340, 0, 320, 240);
        }
        
        // Draw host screen at (680, 0) [320 + 20 + 320 + 20]
        if (screenVideoRef.current && screenVideoRef.current.readyState === screenVideoRef.current.HAVE_ENOUGH_DATA) {
          ctx.drawImage(screenVideoRef.current, 680, 0, 320, 240);
        }
      };
      
      const interval = setInterval(drawFrame, 33);
      return () => clearInterval(interval);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (isRecording) {
        stopTimer();
      }
    };
  }, [isRecording]);

  return (
    <div style={{ padding: 20 }}>
      <h2>Interview (Candidate)</h2>
      <div style={{ display: 'flex', gap: 20 }}>
        <div>
          <h3>Your camera</h3>
          <video ref={localVideoRef} autoPlay playsInline muted style={{ width: 320, height: 240, background: '#000' }} />
        </div>
        <div>
          <h3>Host camera</h3>
          <video ref={hostVideoRef} autoPlay playsInline style={{ width: 320, height: 240, background: '#000' }} />
        </div>
        <div>
          <h3>Host screen</h3>
          <video ref={screenVideoRef} autoPlay playsInline style={{ width: 320, height: 240, background: '#000' }} />
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <button
          style={{
            backgroundColor: '#f44336',
            color: 'white',
            padding: '10px 15px',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
            fontWeight: 'bold'
          }}
          onClick={() => {
            stopLocalAndCleanup();
            socket.emit('end_interview_now');
            navigate('/join');
          }}
        >
          End Interview
        </button>
        <button onClick={toggleScreen} style={{ marginLeft: 10, backgroundColor: screenSharing ? 'green' : undefined }}>{screenSharing ? 'Stop Screen Share' : 'Share Screen'}</button>
        <button
          style={{
            marginLeft: 10,
            backgroundColor: isRecording ? 'red' : '#ccc',
            color: isRecording ? 'white' : 'black',
            padding: '10px 15px',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
            fontWeight: 'bold'
          }}
          onClick={handleToggleRecording}
        >
          {isRecording ? `Stop Recording (${recordingTime})` : 'Record'}
        </button>
        {isRecording && (
          <button
            style={{
              marginLeft: 10,
              backgroundColor: isRecordingPaused ? 'orange' : 'blue',
              color: 'white',
              padding: '10px 15px',
              border: 'none',
              borderRadius: '5px',
              cursor: 'pointer',
              fontWeight: 'bold'
            }}
            onClick={handleTogglePauseRecording}
          >
            {isRecordingPaused ? 'Resume Recording' : 'Pause Recording'}
          </button>
        )}
        <button
          style={{
            marginLeft: 10,
            backgroundColor: '#4CAF50',
            color: 'white',
            padding: '10px 15px',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
            fontWeight: 'bold'
          }}
          onClick={handleUploadRecording}
        >
          Upload to Server
        </button>
      </div>
      <canvas
        ref={recordingCanvasRef}
        style={{ display: 'none', width: 1000, height: 280 }}
      />

      <DebugPanel logs={logs} />
    </div>
  );
}
