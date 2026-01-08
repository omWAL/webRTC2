import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import socket from '../socket';

export default function Interview() {
  const localVideoRef = useRef();
  const hostVideoRef = useRef();
  const screenVideoRef = useRef();
  const [pc, setPc] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [screenSharing, setScreenSharing] = useState(false);
  const [screenStream, setScreenStream] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    const hostId = sessionStorage.getItem('hostId');
    if (!hostId) return navigate('/join');

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    setPc(peer);

    // send local tracks
    async function startLocal() {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      stream.getTracks().forEach((t) => {
        console.log('Adding local track', t.kind, t.label);
        peer.addTrack(t, stream);
      });
    }

    // remote stream handling: if host sends one or multiple streams, attach appropriately
    const remoteStreams = new Map();

    peer.ontrack = (ev) => {
      console.log('Candidate got ontrack', ev);
      const stream = ev.streams && ev.streams[0];
      if (!stream) return;
      // if host video slot empty, use it
      if (!hostVideoRef.current.srcObject) {
        hostVideoRef.current.srcObject = stream;
        console.log('Attached host stream to hostVideoRef', stream.id);
        remoteStreams.set(stream.id, stream);
      } else if (!remoteStreams.has(stream.id) && !screenVideoRef.current.srcObject) {
        // if we already have host video but this is a different stream, treat as screen
        screenVideoRef.current.srcObject = stream;
        console.log('Attached host screen stream to screenVideoRef', stream.id);
        remoteStreams.set(stream.id, stream);
      } else {
        // fallback: replace host video
        hostVideoRef.current.srcObject = stream;
        remoteStreams.set(stream.id, stream);
      }
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
      console.log('Candidate received answer from', from);
      try {
        await peer.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (err) {
        console.error('Failed to set remote description on candidate', err);
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

    // negotiation handler so adding/removing tracks triggers re-negotiation
    peer.onnegotiationneeded = async () => {
      try {
        console.log('Candidate negotiationneeded - creating offer');
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit('webrtc_offer', { to: hostId, sdp: offer });
      } catch (err) {
        console.error('Candidate negotiation failed', err);
      }
    };

    // create offer to host (initial)
    async function createOffer() {
      console.log('Candidate creating offer to host', hostId);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socket.emit('webrtc_offer', { to: hostId, sdp: offer });
    }

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
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
      if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
      peer.close();
      navigate('/join');
    });

    return () => {
      clearTimeout(fallbackOffer);
      socket.off('webrtc_answer');
      socket.off('webrtc_offer');
      socket.off('webrtc_ice');
      socket.off('interview_ended');
      socket.off('host_ready');
      if (peer && peer.connectionState !== 'closed') peer.close();
    };
  }, []);

  // keep reference to the sender used for screen sharing so we can remove it later
  const screenSenderRef = useRef(null);

  async function toggleScreen() {
    if (!pc) return;
    if (!screenSharing) {
      try {
        const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
        setScreenStream(s);
        // add screen track as a separate sender so host can show camera + screen
        const screenTrack = s.getVideoTracks()[0];
        const sender = pc.addTrack(screenTrack, s);
        screenSenderRef.current = sender;
        console.log('Added screen sender', sender);

        screenTrack.onended = () => {
          // stop sharing
          stopScreenSharing();
        };

        setScreenSharing(true);
      } catch (err) {
        console.error('Could not start screen share', err);
      }
    } else {
      stopScreenSharing();
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

    // no need to revert camera since camera sender still exists
    setScreenStreamingFalse();
  }

  function setScreenStreamingFalse() {
    setScreenSharing(false);
    setScreenStream(null);
  }

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
        <button onClick={toggleScreen}>{screenSharing ? 'Stop Screen Share' : 'Share Screen'}</button>
      </div>
    </div>
  );
}
