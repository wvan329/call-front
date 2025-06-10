<template>
  <div class="voice-container">
    <div class="status-indicator" :class="{ active: isConnected }">
      {{ statusText }}
    </div>
    
    <div class="controls">
      <button class="control-button" @click="toggleMute">
        {{ isMuted ? '取消静音' : '静音' }}
      </button>
      <button class="control-button" @click="endCall">
        结束通话
      </button>
    </div>
    
    <audio ref="remoteAudio" autoplay></audio>
  </div>
</template>

<script>
import { ref, onMounted, onBeforeUnmount } from 'vue';

export default {
  setup() {
    const remoteAudio = ref(null);
    const localStream = ref(null);
    const peerConnection = ref(null);
    const socket = ref(null);
    const isConnected = ref(false);
    const isMuted = ref(false);
    const host = window.location.host;
    const pendingCandidates = ref([]);
    const statusText = ref('正在连接...');

    // 初始化WebSocket连接
    const initSocket = () => {
      socket.value = new WebSocket(`ws://${host}/wgk/ws`);
      
      socket.value.onopen = () => {
        statusText.value = '正在建立通话...';
        startCall();
      };
      
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
      
      socket.value.onclose = () => {
        statusText.value = '连接已断开';
        cleanup();
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
        if (event.candidate && socket.value.readyState === WebSocket.OPEN) {
          socket.value.send(JSON.stringify({
            type: 'ice-candidate',
            candidate: event.candidate
          }));
        }
      };

      peerConnection.value.ontrack = (event) => {
        remoteAudio.value.srcObject = event.streams[0];
        isConnected.value = true;
        statusText.value = '通话已连接';
      };
      
      peerConnection.value.oniceconnectionstatechange = () => {
        if (peerConnection.value.iceConnectionState === 'disconnected') {
          statusText.value = '连接断开';
          cleanup();
        }
      };
    };

    // 获取麦克风权限
    const getLocalStream = async () => {
      try {
        localStream.value = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStream.value.getTracks().forEach(track => {
          peerConnection.value.addTrack(track, localStream.value);
        });
      } catch (error) {
        statusText.value = '麦克风访问被拒绝';
        console.error('获取麦克风权限失败:', error);
      }
    };

    // 开始通话
    const startCall = async () => {
      if (isConnected.value) return;
      
      try {
        await initPeerConnection();
        await getLocalStream();

        const offer = await peerConnection.value.createOffer();
        await peerConnection.value.setLocalDescription(offer);

        socket.value.send(JSON.stringify({
          type: 'offer',
          offer: offer
        }));
      } catch (error) {
        statusText.value = '建立通话失败';
        console.error('开始通话失败:', error);
        cleanup();
      }
    };

    // 清理资源
    const cleanup = () => {
      isConnected.value = false;
      
      if (localStream.value) {
        localStream.value.getTracks().forEach(track => track.stop());
        localStream.value = null;
      }
      
      if (peerConnection.value) {
        peerConnection.value.close();
        peerConnection.value = null;
      }
    };

    // 结束通话
    const endCall = () => {
      if (socket.value && socket.value.readyState === WebSocket.OPEN) {
        socket.value.close();
      }
      cleanup();
      statusText.value = '通话已结束';
    };

    // 切换静音状态
    const toggleMute = () => {
      if (localStream.value) {
        localStream.value.getAudioTracks().forEach(track => {
          track.enabled = !track.enabled;
        });
        isMuted.value = !isMuted.value;
      }
    };

    // 处理收到的offer
    const handleOffer = async (data) => {
      try {
        await initPeerConnection();
        await getLocalStream();

        await peerConnection.value.setRemoteDescription(new RTCSessionDescription(data.offer));

        const answer = await peerConnection.value.createAnswer();
        await peerConnection.value.setLocalDescription(answer);

        socket.value.send(JSON.stringify({
          type: 'answer',
          answer: answer
        }));
      } catch (error) {
        statusText.value = '处理通话请求失败';
        console.error('处理offer失败:', error);
        cleanup();
      }
    };

    // 处理收到的answer
    const handleAnswer = async (data) => {
      try {
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
      } catch (error) {
        console.error('处理answer失败:', error);
      }
    };

    // 处理ICE候选
    const handleIceCandidate = async (data) => {
      try {
        const candidate = new RTCIceCandidate(data.candidate);
        if (peerConnection.value.remoteDescription) {
          await peerConnection.value.addIceCandidate(candidate);
        } else {
          pendingCandidates.value.push(candidate);
        }
      } catch (error) {
        console.error('处理ICE候选失败:', error);
      }
    };

    onMounted(() => {
      initSocket();
    });

    onBeforeUnmount(() => {
      endCall();
    });

    return {
      remoteAudio,
      isConnected,
      isMuted,
      statusText,
      toggleMute,
      endCall
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
  flex-direction: column;
  justify-content: center;
  align-items: center;
  background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
  font-family: 'Arial', sans-serif;
}

.status-indicator {
  padding: 15px 30px;
  background-color: #6e8efb;
  color: white;
  border-radius: 50px;
  font-size: 18px;
  font-weight: bold;
  margin-bottom: 30px;
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
  transition: all 0.3s ease;
}

.status-indicator.active {
  background-color: #4CAF50;
}

.controls {
  display: flex;
  gap: 20px;
  margin-top: 20px;
}

.control-button {
  padding: 12px 24px;
  background: linear-gradient(145deg, #6e8efb, #a777e3);
  border: none;
  color: white;
  font-size: 16px;
  font-weight: bold;
  border-radius: 50px;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
}

.control-button:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 15px rgba(0, 0, 0, 0.15);
}

.control-button:active {
  transform: translateY(0);
}

.control-button:nth-child(2) {
  background: linear-gradient(145deg, #ff5e62, #ff9966);
}

@media (max-width: 768px) {
  .status-indicator {
    font-size: 16px;
    padding: 12px 24px;
  }
  
  .controls {
    flex-direction: column;
    gap: 15px;
  }
  
  .control-button {
    width: 200px;
    text-align: center;
  }
}
</style>