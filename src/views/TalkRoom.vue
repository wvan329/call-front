<template>
  <div class="voice-container">
    <div class="voice-button-wrapper">
      <button 
        class="voice-button"
        @mousedown="startCall"
        @mouseup="endCall"
        @touchstart="startCall"
        @touchend="endCall"
        :class="{ 'active': isCalling }"
      >
        <span class="icon">🎤</span>
        <span class="text">按住说话</span>
      </button>
    </div>
    
    <div class="ripple-container" v-if="isCalling">
      <div class="ripple" v-for="(ripple, index) in ripples" :key="index" :style="ripple.style"></div>
    </div>
    
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
    const host = window.location.host;
    const pendingCandidates = ref([]);
    const ripples = ref([]);
    let rippleInterval = null;

    // 初始化WebSocket连接
    const initSocket = () => {
      socket.value = new WebSocket(`ws://${host}/wgk/ws`);
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

      peerConnection.value.onicecandidate = (event) => {
        if (event.candidate) {
          socket.value.send(JSON.stringify({
            type: 'ice-candidate',
            candidate: event.candidate
          }));
        }
      };

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

    // 创建水波动画
    const createRipple = () => {
      const size = Math.random() * 200 + 100;
      const x = Math.random() * 100;
      const y = Math.random() * 100;
      
      ripples.value.push({
        style: {
          width: `${size}px`,
          height: `${size}px`,
          left: `${x}%`,
          top: `${y}%`,
          opacity: Math.random() * 0.3 + 0.1,
          animationDuration: `${Math.random() * 3 + 2}s`
        }
      });
      
      // 限制波纹数量
      if (ripples.value.length > 10) {
        ripples.value.shift();
      }
    };

    // 开始通话
    const startCall = async () => {
      if (isCalling.value) return;
      isCalling.value = true;
      
      // 开始水波动画
      rippleInterval = setInterval(createRipple, 300);

      await initPeerConnection();
      await getLocalStream();

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
      
      // 停止水波动画
      clearInterval(rippleInterval);
      setTimeout(() => {
        ripples.value = [];
      }, 2000);

      if (localStream.value) {
        localStream.value.getTracks().forEach(track => track.stop());
      }
      if (peerConnection.value) {
        peerConnection.value.close();
      }
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
      if (peerConnection.value.signalingState !== 'have-local-offer') {
        console.warn('状态不正确，不能 setRemoteDescription(answer)');
        return;
      }
      await peerConnection.value.setRemoteDescription(new RTCSessionDescription(data.answer));
      for (const candidate of pendingCandidates.value) {
        try {
          await peerConnection.value.addIceCandidate(candidate);
        } catch (e) {
          console.error('添加缓存的 ICE 失败:', e);
        }
      }
      pendingCandidates.value = [];
    };

    // 处理ICE候选
    const handleIceCandidate = async (data) => {
      const candidate = new RTCIceCandidate(data.candidate);
      if (peerConnection.value.remoteDescription) {
        try {
          await peerConnection.value.addIceCandidate(candidate);
        } catch (e) {
          console.error('添加ICE候选失败:', e);
        }
      } else {
        pendingCandidates.value.push(candidate);
      }
    };

    onMounted(() => {
      initSocket();
    });

    return {
      startCall,
      endCall,
      remoteAudio,
      isCalling,
      ripples
    };
  }
};
</script>

<style scoped>
.voice-container {
  position: relative;
  width: 100%;
  height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
  background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
  overflow: hidden;
}

.voice-button-wrapper {
  position: relative;
  z-index: 10;
}

.voice-button {
  width: 180px;
  height: 180px;
  border-radius: 50%;
  background: linear-gradient(145deg, #6e8efb, #a777e3);
  border: none;
  color: white;
  font-size: 20px;
  font-weight: bold;
  cursor: pointer;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  transition: all 0.3s ease;
  position: relative;
  overflow: hidden;
  outline: none;
}

.voice-button:hover {
  transform: scale(1.05);
  box-shadow: 0 15px 30px rgba(0, 0, 0, 0.3);
}

.voice-button.active {
  background: linear-gradient(145deg, #ff5e62, #ff9966);
  transform: scale(0.95);
  box-shadow: 0 5px 15px rgba(0, 0, 0, 0.2);
}

.voice-button .icon {
  font-size: 50px;
  margin-bottom: 10px;
  transition: all 0.3s ease;
}

.voice-button.active .icon {
  transform: scale(1.2);
}

.voice-button .text {
  transition: all 0.3s ease;
}

.voice-button.active .text {
  content: '松开结束';
}

.ripple-container {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.ripple {
  position: absolute;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0) 70%);
  transform: translate(-50%, -50%) scale(0);
  animation: ripple-animation linear forwards;
}

@keyframes ripple-animation {
  to {
    transform: translate(-50%, -50%) scale(1);
    opacity: 0;
  }
}

@media (max-width: 768px) {
  .voice-button {
    width: 150px;
    height: 150px;
    font-size: 18px;
  }
  
  .voice-button .icon {
    font-size: 40px;
  }
}
</style>