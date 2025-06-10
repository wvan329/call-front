<template>
  <div>
    <button @mousedown="startCall" @mouseup="endCall">按住说话</button>
    <audio ref="remoteAudio" autoplay></audio>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue';

export default {
  setup() {
    const remoteAudio = ref(null);
    const localStream = ref(null);
    const peerConnection = ref(null);
    const socket = ref(null);
    const isCalling = ref(false);

    // 初始化WebSocket连接
    const initSocket = () => {
      socket.value = new WebSocket('wss://59.110.35.198/wgk/ws');
      
      socket.value.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'offer') {
          await handleOffer(data);
        } else if (data.type === 'answer') {
          await handleAnswer(data);
        } else if (data.type === 'ice-candidate') {
          await handleIceCandidate(data);
        }
      };
    };

    // 初始化PeerConnection
    const initPeerConnection = () => {
      peerConnection.value = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' }
        ]
      });

      // 处理ICE候选
      peerConnection.value.onicecandidate = (event) => {
        if (event.candidate) {
          socket.value.send(JSON.stringify({
            type: 'ice-candidate',
            candidate: event.candidate
          }));
        }
      };

      // 处理远程流
      peerConnection.value.ontrack = (event) => {
        remoteAudio.value.srcObject = event.streams[0];
      };
    };

    // 获取麦克风权限
    const getLocalStream = async () => {
      localStream.value = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStream.value.getTracks().forEach(track => {
        peerConnection.value.addTrack(track, localStream.value);
      });
    };

    // 开始通话
    const startCall = async () => {
      if (isCalling.value) return;
      isCalling.value = true;
      
      await initPeerConnection();
      await getLocalStream();
      
      // 创建offer
      const offer = await peerConnection.value.createOffer();
      await peerConnection.value.setLocalDescription(offer);
      
      socket.value.send(JSON.stringify({
        type: 'offer',
        offer: offer
      }));
    };

    // 结束通话
    const endCall = () => {
      if (!isCalling.value) return;
      isCalling.value = false;
      
      localStream.value.getTracks().forEach(track => track.stop());
      peerConnection.value.close();
    };

    // 处理收到的offer
    const handleOffer = async (data) => {
      await initPeerConnection();
      await getLocalStream();
      
      await peerConnection.value.setRemoteDescription(new RTCSessionDescription(data.offer));
      
      const answer = await peerConnection.value.createAnswer();
      await peerConnection.value.setLocalDescription(answer);
      
      socket.value.send(JSON.stringify({
        type: 'answer',
        answer: answer
      }));
    };

    // 处理收到的answer
    const handleAnswer = async (data) => {
      await peerConnection.value.setRemoteDescription(new RTCSessionDescription(data.answer));
    };

    // 处理ICE候选
    const handleIceCandidate = async (data) => {
      try {
        await peerConnection.value.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.error('添加ICE候选失败:', e);
      }
    };

    onMounted(() => {
      initSocket();
    });

    return {
      startCall,
      endCall,
      remoteAudio
    };
  }
};
</script>