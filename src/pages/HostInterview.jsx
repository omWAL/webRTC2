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

export default function HostInterview() {
  const localVideoRef = useRef();
  const candidateVideoRef = useRef();
  const screenVideoRef = useRef();
  const [pc, setPc] = useState(null);
  const pcRef = useRef(null);
  const [localStream, setLocalStream] = useState(null);
  const localStreamRef = useRef(null);
  const [hostSharing, setHostSharing] = useState(false);
  const hostScreenRef = useRef({ sender: null, stream: null });
  const navigate = useNavigate();

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState('00:00');
  const recordingCanvasRef = useRef(null);

  function stopLocalAndCleanup() {
    try {
      if (hostScreenRef.current && hostScreenRef.current.stream) hostScreenRef.current.stream.getTracks().forEach((t) => t.stop());
    } catch (e) {}
    try {
      if (localStreamRef.current) localStreamRef.current.getTracks().forEach((t) => t.stop());
    } catch (e) {}
    try {
      if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    } catch (e) {}
    setHostSharing(false);
    setLocalStream(null);
    localStreamRef.current = null;
    setPc(null);
  }

  // debug logs for UI
  const [logs, setLogs] = React.useState([]);
  function pushLog(msg) {
    setLogs((s) => [...s, `${new Date().toLocaleTimeString()} - ${msg}`]);
    console.log(msg);
  }

  // toggle host screen sharing (adds/removes display track and forces negotiation)
  async function toggleHostScreen() {
    if (!pc) return pushLog('PC not ready');
    const candidate = sessionStorage.getItem('activeCandidate');
    try {
      if (!hostScreenRef.current.stream) {
        pushLog('Starting host screen share...');
        const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
        hostScreenRef.current.stream = s;
        const track = s.getVideoTracks()[0];
        const sender = pc.addTrack(track, s);
        hostScreenRef.current.sender = sender;
        setHostSharing(true);
        pushLog('Host added screen track, forcing offer to candidate ' + candidate);

        // ensure negotiation: create offer and send to candidate
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('webrtc_offer', { to: candidate, sdp: offer });
          pushLog('Host sent offer for screen to candidate');
          // notify candidate explicitly that a screen share started (helps with classification)
          socket.emit('screen_share_started', { to: candidate });
        } catch (err) {
          pushLog('Host failed to create/send offer for screen: ' + err.message);
        }

        track.onended = async () => {
          pushLog('Host screen track ended');
          try { if (hostScreenRef.current.sender) pc.removeTrack(hostScreenRef.current.sender); } catch(e) {}
          hostScreenRef.current.sender = null;
          hostScreenRef.current.stream = null;
          setHostSharing(false);
          // notify candidate that screen stopped
          try { socket.emit('screen_share_stopped', { to: candidate }); } catch(e) {}
          // renegotiate to remove track
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('webrtc_offer', { to: candidate, sdp: offer });
            pushLog('Host sent offer after stopping screen');
          } catch (err) {
            pushLog('Host failed renegotiation after stopping screen: ' + err.message);
          }
        };
      } else {
        pushLog('Stopping host screen share...');
        hostScreenRef.current.stream.getTracks().forEach((t) => t.stop());
        if (hostScreenRef.current.sender) try { pc.removeTrack(hostScreenRef.current.sender); } catch (e) {}
        hostScreenRef.current.sender = null;
        hostScreenRef.current.stream = null;
        setHostSharing(false);

        // notify candidate that screen stopped
        try { socket.emit('screen_share_stopped', { to: candidate }); } catch(e) {}

        // create offer to renegotiate without screen
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('webrtc_offer', { to: candidate, sdp: offer });
          pushLog('Host sent offer after stopping screen (manual)');
        } catch (err) {
          pushLog('Host failed to send offer after stopping screen: ' + err.message);
        }
      }
    } catch (err) {
      pushLog('Host screen share failed: ' + err.message);
    }
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
          downloadRecording(blob, `host-interview-${Date.now()}.webm`);
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
        
        // Draw candidate camera at (340, 0) [320 + 20 gap]
        if (candidateVideoRef.current && candidateVideoRef.current.readyState === candidateVideoRef.current.HAVE_ENOUGH_DATA) {
          ctx.drawImage(candidateVideoRef.current, 340, 0, 320, 240);
        }
        
        // Draw candidate screen at (680, 0) [320 + 20 + 320 + 20]
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

  useEffect(() => {
    const session = sessionStorage.getItem('hostSession');
    const candidate = sessionStorage.getItem('activeCandidate');
    if (!session || !candidate) return navigate('/host');

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    setPc(peer);
    pcRef.current = peer;

    async function startLocal() {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      stream.getTracks().forEach((t) => {
        console.log('Host adding local track', t.kind, t.label);
        peer.addTrack(t, stream);
      });
    }



    startLocal().then(() => {
      console.log('Host local started, notifying candidate', candidate);
      socket.emit('host_ready', { to: candidate });
    }).catch((err) => console.error('Host failed to start local stream', err));

    // Keep track of remote streams
    const remoteStreams = new Map();

    // Negotiation management (polite peer) to handle glare
    const makingOfferHost = { current: false };
    const politeHost = true; // host will be polite

    peer.onnegotiationneeded = async () => {
      try {
        pushLog('Host negotiationneeded - creating offer');
        makingOfferHost.current = true;
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        pushLog('Host senders: ' + peer.getSenders().map((s) => s.track && s.track.id).join(','));
        socket.emit('webrtc_offer', { to: candidate, sdp: offer });
      } catch (err) {
        pushLog('Host negotiation failed: ' + err.message);
      } finally {
        makingOfferHost.current = false;
      }
    };

    // handle answers to host-initiated offers
    socket.on('webrtc_answer', async ({ from, sdp }) => {
      pushLog('Host received answer from ' + from);
      try {
        await peer.setRemoteDescription(new RTCSessionDescription(sdp));
        pushLog('Host set remote description after answer');
      } catch (err) {
        pushLog('Host failed to set remote description: ' + err.message);
      }
    });

    // handle incoming offers with polite collision handling
    socket.on('webrtc_offer', async ({ from, sdp }) => {
      pushLog('Host received offer from ' + from);
      const offer = new RTCSessionDescription(sdp);
      const readyForOffer = !makingOfferHost.current && (peer.signalingState === 'stable');
      const offerCollision = !readyForOffer;
      if (offerCollision) pushLog('Host detected offer collision, polite=' + politeHost);
      if (offerCollision && !politeHost) {
        pushLog('Host ignoring offer due to collision');
        return;
      }
      try {
        await peer.setRemoteDescription(offer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit('webrtc_answer', { to: from, sdp: answer });
        pushLog('Host sent answer to ' + from);
      } catch (err) {
        pushLog('Host failed to handle offer: ' + err.message);
      }
    });

    // Simple ontrack handler - attach immediately
    peer.ontrack = (ev) => {
      console.log('Host got ontrack event', ev.track.kind, ev.track.id);
      let stream = ev.streams && ev.streams[0];
      if (!stream) {
        stream = new MediaStream();
        if (ev.track) stream.addTrack(ev.track);
      }
      
      const audioCount = stream.getAudioTracks().length;
      const videoCount = stream.getVideoTracks().length;
      pushLog('Host ontrack: audio=' + audioCount + ' video=' + videoCount + ' trackKind=' + ev.track.kind);
      
      // Simple heuristic: if no audio tracks, treat as screen share
      const isScreen = audioCount === 0 && videoCount > 0;
      
      if (isScreen) {
        pushLog('Host: attaching to screen share element');
        if (screenVideoRef.current) screenVideoRef.current.srcObject = stream;
        setHostSharing(true);
      } else {
        pushLog('Host: attaching to candidate camera element');
        if (candidateVideoRef.current) candidateVideoRef.current.srcObject = stream;
      }
      
      remoteStreams.set(stream.id || ev.track.id, { type: isScreen ? 'screen' : 'camera', stream });
    };

    peer.onicecandidate = (e) => {
      if (e.candidate) {
        console.log('Host sending ICE to candidate', candidate, e.candidate);
        socket.emit('webrtc_ice', { to: candidate, candidate: e.candidate });
      }
    };

    // when an offer arrives
    socket.on('webrtc_offer', async ({ from, sdp }) => {
      console.log('Host received offer from', from);
      if (from !== candidate) return; // ignore other offers
      try {
        await peer.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit('webrtc_answer', { to: from, sdp: answer });
        console.log('Host sent answer to', from);
      } catch (err) {
        console.error('Host failed to handle offer', err);
      }
    });

    socket.on('webrtc_ice', async ({ candidate: c, from }) => {
      console.log('Host received ICE from', from, c);
      try {
        await peer.addIceCandidate(new RTCIceCandidate(c));
      } catch (err) {
        console.warn('Failed to add ICE candidate', err);
      }
    });

    socket.on('interview_ended_host', () => {
      // cleanup
      stopLocalAndCleanup();
      sessionStorage.removeItem('activeCandidate');
      navigate('/host');
    });

    return () => {
      socket.off('webrtc_offer');
      socket.off('webrtc_ice');
      socket.off('webrtc_answer');
      socket.off('interview_ended_host');
      try {
        if (hostScreenRef && hostScreenRef.current && hostScreenRef.current.stream) hostScreenRef.current.stream.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      if (peer && peer.connectionState !== 'closed') peer.close();
    };
  }, []);

  function endInterview() {
    const code = sessionStorage.getItem('hostSession');
    console.log('Host clicked End Interview, code=', code);
    // perform immediate local cleanup to stop camera immediately
    stopLocalAndCleanup();

    if (code) {
      socket.emit('end_interview', { code }, (res) => {
        // no callback on server currently, but keep for future
        console.log('end_interview ack', res);
      });
    } else {
      // fallback
      socket.emit('end_interview_now');
    }
  }

  return (
    <div style={{ padding: 20 }}>
      <h2>Host Interview</h2>
      <div style={{ display: 'flex', gap: 20 }}>
        <div>
          <h3>Your camera</h3>
          <video ref={localVideoRef} autoPlay playsInline muted style={{ width: 320, height: 240, background: '#000' }} />
        </div>
        <div>
          <h3>Candidate camera</h3>
          <video ref={candidateVideoRef} autoPlay playsInline style={{ width: 320, height: 240, background: '#000' }} />
        </div>
        <div>
          <h3>Candidate screen</h3>
          <video ref={screenVideoRef} autoPlay playsInline style={{ width: 320, height: 240, background: '#000' }} />
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <button onClick={endInterview}>End Interview</button>
        <button
          style={{ marginLeft: 10, backgroundColor: hostSharing ? 'green' : undefined }}
          onClick={toggleHostScreen}
        >{hostSharing ? 'Stop Screen' : 'Share Screen'}</button>
        <button style={{ marginLeft: 10 }} onClick={() => {
          const code = sessionStorage.getItem('hostSession');
          if (code) socket.emit('start_next', { code });
        }}>Start Next</button>
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
