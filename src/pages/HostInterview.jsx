import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import socket from '../socket';

export default function HostInterview() {
  const localVideoRef = useRef();
  const candidateVideoRef = useRef();
  const screenVideoRef = useRef();
  const [pc, setPc] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    const session = sessionStorage.getItem('hostSession');
    const candidate = sessionStorage.getItem('activeCandidate');
    if (!session || !candidate) return navigate('/host');

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    setPc(peer);

    async function startLocal() {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      stream.getTracks().forEach((t) => {
        console.log('Host adding local track', t.kind, t.label);
        peer.addTrack(t, stream);
      });
    }

    // screen sharing helper for host
    const hostScreenRef = { sender: null, stream: null };

    // helper to toggle host screen (attach to window so UI button can call it)
    socket._hostShare = async function toggleHostScreen() {
      try {
        if (!hostScreenRef.stream) {
          const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
          hostScreenRef.stream = s;
          const track = s.getVideoTracks()[0];
          const sender = peer.addTrack(track, s);
          hostScreenRef.sender = sender;
          console.log('Host added screen track', sender);

          track.onended = () => {
            try {
              if (hostScreenRef.sender) peer.removeTrack(hostScreenRef.sender);
            } catch (e) {}
            hostScreenRef.sender = null;
            hostScreenRef.stream = null;
          };
        } else {
          // stop screen
          hostScreenRef.stream.getTracks().forEach((t) => t.stop());
          if (hostScreenRef.sender) peer.removeTrack(hostScreenRef.sender);
          hostScreenRef.sender = null;
          hostScreenRef.stream = null;
        }
        // trigger negotiation by adding/removing track
      } catch (err) {
        console.error('Host screen share failed', err);
      }
    };

    startLocal().then(() => {
      console.log('Host local started, notifying candidate', candidate);
      socket.emit('host_ready', { to: candidate });
    }).catch((err) => console.error('Host failed to start local stream', err));

    // Keep track of remote streams
    const remoteStreams = new Map();

    // negotiation handler (when host adds tracks like screen)
    peer.onnegotiationneeded = async () => {
      try {
        console.log('Host negotiationneeded - creating offer');
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit('webrtc_offer', { to: candidate, sdp: offer });
      } catch (err) {
        console.error('Host negotiation failed', err);
      }
    };

    // handle answers to host-initiated offers
    socket.on('webrtc_answer', async ({ from, sdp }) => {
      console.log('Host received answer from', from);
      try {
        await peer.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (err) {
        console.error('Host failed to set remote description', err);
      }
    });

    peer.ontrack = (ev) => {
      console.log('Host got ontrack', ev);
      const stream = ev.streams && ev.streams[0];
      if (!stream) return;

      // If we don't have a candidate camera yet, attach this stream there
      if (!candidateVideoRef.current.srcObject) {
        candidateVideoRef.current.srcObject = stream;
        remoteStreams.set(stream.id, { type: 'camera', stream });
        console.log('Attached candidate camera stream', stream.id);
        return;
      }

      // If this stream is new and not the same as candidate camera, attach to screen
      if (!remoteStreams.has(stream.id)) {
        remoteStreams.set(stream.id, { type: 'screen', stream });
        if (screenVideoRef.current) screenVideoRef.current.srcObject = stream;
        console.log('Attached candidate screen stream', stream.id);
        return;
      }

      // fallback: overwrite candidate camera
      candidateVideoRef.current.srcObject = stream;
      console.log('Replaced candidate camera with stream', stream.id);
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
      try {
        if (hostScreenRef && hostScreenRef.stream) hostScreenRef.stream.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
      peer.close();
      sessionStorage.removeItem('activeCandidate');
      navigate('/host');
    });

    return () => {
      socket.off('webrtc_offer');
      socket.off('webrtc_ice');
      socket.off('webrtc_answer');
      socket.off('interview_ended_host');
      try {
        if (hostScreenRef && hostScreenRef.stream) hostScreenRef.stream.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      if (peer && peer.connectionState !== 'closed') peer.close();
    };
  }, []);

  function endInterview() {
    const code = sessionStorage.getItem('hostSession');
    console.log('Host clicked End Interview, code=', code);
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
        <button style={{ marginLeft: 10 }} onClick={() => { if (socket._hostShare) socket._hostShare(); else console.warn('host share not available'); }}>Share Screen</button>
      </div>
    </div>
  );
}
